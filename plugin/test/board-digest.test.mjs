import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../lib/store.js'
import { ensureHub, HUB_ID } from '../lib/hub.js'
import { BoardDigest, activeProjects, boardView, checkDigest, material, fingerprint, DIGEST_SYSTEM, MIN_GAP_MS } from '../lib/board-digest.js'

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime()

function setup(t, { reply = '{"story":"两件梳理都交了，等你看一眼。","rows":[{"ref":"t1","line":"群成员在做什么的梳理"}]}', now = at(18, 20) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mira-digest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const hubStore = new ProjectStore(join(root, 'hub'), { warn() {} }); hubStore.load(); ensureHub(hubStore)
  const said = (seq, when, text) => ({ seq, type: 'message.posted', messageId: 'm' + seq, author: { kind: 'human', id: 'owner' }, trust: 'principal', text, native: true, at: when })
  const project = (id, name, events, threads, decisions = []) => ({ id, name, hub: false, instructions: name + '的目标', events, threads: new Map(threads.map(x => [x.id, x])), decisions: new Map(decisions.map(d => [d.id, d])) })
  const projects = { projects: new Map([
    ['p_a', project('p_a', 'CLIF 群梳理', [said(1, at(18, 10), '明天会议他们要讨论什么'), { seq: 2, type: 'file.published', path: 'out/梳理.md', at: at(18, 16) }, { seq: 3, type: 'member.model', at: at(18, 19) }],
      [{ id: 't_x', title: '梳理群成员在做什么', state: 'review_ready', resolved: false, updatedAt: at(18, 16), summary: '两份交付：docs/a.md 人员依赖' }, { id: 't_y', title: '补一份图', state: 'working', resolved: false, updatedAt: at(18, 15) }])],
    ['p_b', project('p_b', '桌宠项目', [{ seq: 1, type: 'thread.updated', threadId: 't_q', at: at(17, 20) }],
      [{ id: 't_q', title: '桌宠接入', state: 'working', resolved: false, updatedAt: at(17, 20) }], [{ id: 'd1', threadId: 't_q', question: '外壳用哪种？', chosen: null, withdrawn: false }])],
    ['p_old', project('p_old', '旧项目', [{ seq: 1, type: 'message.posted', at: at(10, 9), author: { kind: 'human' }, text: 'x' }, { seq: 2, type: 'member.model', at: at(18, 19) }], [])],
  ]) }
  let clock = now
  const calls = []
  const digest = new BoardDigest({ hubStore, projects, now: () => clock, complete: async c => { calls.push(c); return typeof reply === 'function' ? reply(c) : reply } })
  return { hubStore, projects, digest, calls, set: v => { clock = v }, hub: () => hubStore.get(HUB_ID) }
}

test('only projects that really moved in the last days count, newest first; bookkeeping like a model switch does not', t => {
  const f = setup(t)
  assert.deepEqual(activeProjects(f.projects, at(18, 20)).map(x => x.p.id), ['p_a', 'p_b'])
  const m = material(f.projects.projects.get('p_a'), at(18, 20))
  assert.match(m.text, /他在这个项目里最近说的话[\s\S]*明天会议他们要讨论什么/)
  assert.match(m.text, /\[t1\] 梳理群成员在做什么｜做完了，等他验收｜等他｜/)
  assert.match(m.text, /最近交付的文件：梳理\.md/)
  assert.equal(m.items.get('t1').waits, true)
  assert.equal(m.items.get('t2').waits, false)
  assert.match(DIGEST_SYSTEM, /不写文件路径/)
})

test('a paragraph is used only when it is plain words about tasks that wait on the owner', t => {
  const items = material(setup(t).projects.projects.get('p_a')).items
  assert.deepEqual(checkDigest('```json\n{"story":"两份梳理交了。","rows":[{"ref":"t1","line":"成员梳理"},{"ref":"t2","line":"在做的不算"},{"ref":"t9","line":"不存在"},{"ref":"t1","line":"重复"}]}\n```', items),
    { story: '两份梳理交了。', rows: [{ threadId: 't_x', line: '成员梳理' }] })
  assert.throws(() => checkDigest('{"story":"见 docs/a.md 的第二节"}', items), /leaks/)
  assert.throws(() => checkDigest('{"story":"任务 t_9407136f7c 交付了"}', items), /leaks/)
  assert.throws(() => checkDigest('{"story":""}', items), /no_story/)
  assert.throws(() => checkDigest('好的', items), /not_json/)
  assert.deepEqual(checkDigest('{"story":"好了。","rows":[{"ref":"t1","line":"看 out/x.md"}]}', items).rows, [], 'a line with a path is dropped')
})

test('a project is rewritten when it changed, at most every ten minutes; a failure is retried after the wait', async t => {
  const f = setup(t)
  const first = await f.digest.tick()
  assert.equal(first.forProject, 'p_a')
  assert.equal(first.story, '两件梳理都交了，等你看一眼。')
  assert.equal(f.calls.length, 1)
  const second = await f.digest.tick()
  assert.equal(second.forProject, 'p_b', 'the next moving project')
  assert.deepEqual(second.rows, [{ threadId: 't_q', line: '群成员在做什么的梳理' }], 'its t1 is the task holding a question for the owner')
  assert.equal(await f.digest.tick(), null, 'nothing changed')
  f.projects.projects.get('p_a').events.push({ seq: 4, type: 'message.posted', at: at(18, 20, 1), author: { kind: 'human' }, text: '再看看' })
  f.set(at(18, 20, 2))
  assert.equal(await f.digest.tick(), null, 'changed, but rewritten under ten minutes ago')
  f.set(at(18, 20) + MIN_GAP_MS + 1)
  assert.equal((await f.digest.tick()).forProject, 'p_a')

  const g = setup(t, { reply: () => { throw new Error('模型调用失败') } })
  assert.match((await g.digest.tick()).error, /模型调用失败/)
  g.set(at(18, 20) + 60_000)
  assert.equal((await g.digest.tick()).forProject, 'p_b', 'the failed one waits; the next project goes')
  g.set(at(18, 20) + MIN_GAP_MS + 1)
  assert.equal((await g.digest.tick()).forProject, 'p_a', 'after the wait the failed one is tried again')
})

test('the board: moving projects with their paragraph and waiting rows, the rest quiet', async t => {
  const f = setup(t)
  await f.digest.tick()
  const view = boardView(f.projects, f.hub(), at(18, 20))
  assert.deepEqual(view.active.map(a => a.name), ['CLIF 群梳理', '桌宠项目'])
  assert.equal(view.active[0].story, '两件梳理都交了，等你看一眼。')
  assert.equal(view.active[0].current, true)
  assert.deepEqual(view.active[0].rows.map(r => [r.title, r.kind, r.line]), [['梳理群成员在做什么', 'review', '群成员在做什么的梳理']])
  assert.equal(view.active[1].story, null, 'not written yet: the board shows the rows alone')
  assert.deepEqual(view.active[1].rows.map(r => r.kind), ['decision'])
  assert.deepEqual(view.quiet.map(q => q.name), ['旧项目'])
  f.projects.projects.get('p_a').events.push({ seq: 4, type: 'thread.updated', at: at(18, 20, 1) })
  assert.equal(boardView(f.projects, f.hub(), at(18, 20, 1)).active[0].current, false, 'a paragraph older than the last move is marked as such')
  assert.equal(f.hub().events.filter(e => e.type === 'board.digest').length, 1, 'kept in the assistant\'s own log')
})
