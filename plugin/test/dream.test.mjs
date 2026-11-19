import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../lib/store.js'
import { ensureHub, HUB_ID } from '../lib/hub.js'
import { Dream, diaryHtml, numbersIn, leaksIds } from '../lib/dream.js'

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime()

function setup(t, { complete, now = at(14, 3) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mira-dream-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const hubStore = new ProjectStore(root, { warn() {} }); hubStore.load(); ensureHub(hubStore)
  const said = (id, when, text) => ({ type: 'message.posted', messageId: id, threadId: null, author: { kind: 'human', id: 'owner' }, trust: 'principal', text, native: true, at: when, seq: 0 })
  const project = { id: 'p_1', name: '用户访谈整理', hub: false,
    events: [said('m1', at(13, 23, 40), '报告只用到 11-06 的数据，回头再补'), said('m2', at(13, 10), '早'), said('m3', at(12, 9, 30), '开工'), said('m4', at(11, 9, 50), '开工')],
    threads: new Map([['t_a', { id: 't_a', title: '整理 hub 数据', state: 'review_ready', resolved: false, updatedAt: at(13, 16, 21), summary: '写好了说明' }]]),
    files: new Map([['docs/说明.md', { id: 'f_x', path: 'docs/说明.md', versions: [{ id: 'f_x', at: at(13, 16, 20) }] }]]) }
  const projects = { projects: new Map([['p_1', project]]) }
  let clock = now
  const calls = []
  const dream = new Dream({ hubStore, projects, now: () => clock, complete: async c => { calls.push(c); return complete(c, calls.length) }, look: { current: () => ({ name: '小芽', traits: ['温和'] }) } })
  return { hubStore, dream, calls, set: v => { clock = v } }
}

const intentReply = JSON.stringify({ interests: [{ topic: '看板娘', kind: '兴趣', refs: ['w1'] }, { topic: '没出处的', refs: ['w99'] }], needs: [], signals: [] })

test('a dream runs only inside the sleep window, after the owner has been quiet, once a night', t => {
  const f = setup(t, { complete: async () => '{}' })
  f.set(at(14, 0, 30)); assert.equal(f.dream.due().ok, false, 'before 01:00')
  f.set(at(13, 23, 50)); assert.equal(f.dream.due().ok, false)
  f.set(at(14, 0, 5) + 3_600_000); assert.equal(f.dream.due().ok, true)
  f.set(at(14, 9, 5)); assert.equal(f.dream.due().ok, false, 'after 09:00')
  f.hubStore.append(HUB_ID, { type: 'dream.done', day: '2026-11-14', picked: [] })
  f.set(at(14, 3)); assert.equal(f.dream.due().ok, false, 'once a night')
})

test('the morning guess is the average first word of earlier days', t => {
  const f = setup(t, { complete: async () => '{}' })
  const r = f.dream.rhythm(at(14, 3))
  assert.equal(r.wakeHour, 9.75, '09:30, 09:50, 10:00 → about 09:45')
  assert.equal(r.lastActive, at(13, 23, 40))
})

test('the night keeps one checked item per lane: real refs, a project behind 可以做, nothing muted, no self-score under 3', async t => {
  const night = JSON.stringify({ picked: [
    { lane: 'do', title: '补齐 11-06 之后的数据', body: '分四步补。', refs: ['t1', 'w1'], scores: { relevant: 5, new: 4, actionable: 5, sourced: 5 } },
    { lane: 'do', title: '第二条可以做', body: '多的。', refs: ['t1'] },
    { lane: 'read', title: '看说明', body: '还没打开。', refs: ['f1'] },
    { lane: 'care', title: '早点睡', body: '连着几晚很晚。', refs: ['w404'] },
    { lane: 'later', title: '不认识', body: '…', refs: ['w1'] },
  ], dropped: [{ lane: 'read', title: '动效文章', reason: '用不上' }], empty: [{ lane: 'care', reason: '证据不够' }] })
  const diary = JSON.stringify({ line: '早。昨晚我替你看了两件事。', opening: '你 23:40 合上电脑。', night: [{ time: '03:00', text: '翻了报告。' }], closing: '等你。' })
  // (the read item below points at f1, the one file the project published)
  const f = setup(t, { complete: async (c, n) => n === 1 ? intentReply : n === 2 ? night : diary })
  f.hubStore.append(HUB_ID, { type: 'dream.muted', topic: '别的话题' })
  const done = await f.dream.run({ force: true })
  assert.deepEqual(done.picked.map(p => p.lane), ['do', 'read'])
  assert.equal(done.picked[0].projectId, 'p_1'); assert.equal(done.picked[0].threadId, 't_a')
  assert.equal(done.picked[1].fileId, 'f_x')
  assert.ok(done.rejected.includes('可以做超过一条'))
  assert.ok(done.rejected.includes('想说的没有可核对的出处'))
  assert.ok(done.rejected.includes('不认识的类别'))
  assert.equal(done.intent.length, 1, 'the intent line without a real ref is dropped')
  assert.equal(done.line, '早。昨晚我替你看了两件事。')
  assert.ok(f.calls[1].input.includes('[i1]'), 'the night sees what the day noticed')
})

test('a muted topic never reaches the morning, and the diary may not bring numbers of its own', async t => {
  const night = JSON.stringify({ picked: [{ lane: 'do', title: '补齐报告数据', body: '分四步。', refs: ['t1'] }, { lane: 'care', title: '早点睡', body: '最近很晚。', refs: ['w1'] }] })
  const bad = JSON.stringify({ line: '早，你睡了 7 个小时。', opening: '', night: [], closing: '' })
  const f = setup(t, { complete: async (c, n) => n === 1 ? intentReply : n === 2 ? night : bad })
  f.hubStore.append(HUB_ID, { type: 'dream.muted', topic: '早点睡' })
  const done = await f.dream.run({ force: true })
  assert.deepEqual(done.picked.map(p => p.lane), ['do'])
  assert.equal(done.diary, null, 'two tries with a stray number: no diary')
  assert.equal(done.line, '昨晚留下 1 件。')
  assert.equal(f.calls.length, 4, 'the diary is retried once')
  assert.ok(done.rejected.some(r => r.includes('7')))
  assert.deepEqual(numbersIn('03:05 交付了 2 个'), ['03', '05', '2'])
  assert.equal(leaksIds('先看了 t1 交付的文件'), true); assert.equal(leaksIds('w2 和 i1'), true); assert.equal(leaksIds('docs/v4 和 utf8'), false)
})

test('a night with nothing the owner typed writes an empty dream without asking the model', async t => {
  const f = setup(t, { complete: async () => { throw new Error('should not be called') } })
  f.set(at(20, 3))
  const done = await f.dream.run({ force: true })
  assert.equal(done.picked.length, 0); assert.equal(f.calls.length, 0)
})

test('a night that starts before the owner has typed anything writes nothing, so the night can still run later', async t => {
  const f = setup(t, { complete: async () => { throw new Error('should not be called') } })
  f.set(at(20, 5, 45))
  assert.equal(await f.dream.run(), null)
  assert.equal(f.dream.done('2026-11-20'), undefined)
  assert.equal(f.dream.due().ok, true, 'the night is not used up')
})

test('the owner answers each item; 别提这个 mutes it; the page shows the newest dream with the answers', async t => {
  const night = JSON.stringify({ picked: [{ lane: 'read', title: '看说明', body: '还没打开。', refs: ['f1'] }] })
  const diary = JSON.stringify({ line: '早。', opening: '', night: [], closing: '' })
  const f = setup(t, { complete: async (c, n) => n === 1 ? intentReply : n === 2 ? night : diary })
  const done = await f.dream.run({ force: true })
  f.dream.react({ day: done.day, lane: 'read', reaction: 'mute' })
  assert.deepEqual(f.dream.muted(), ['看说明'])
  assert.throws(() => f.dream.react({ day: done.day, lane: 'do', reaction: 'opened' }), /没有这一条/)
  assert.throws(() => f.dream.react({ day: done.day, lane: 'read', reaction: 'love' }), /不认识/)
  const view = f.dream.view(at(14, 9))
  assert.equal(view.latest.picked[0].reaction, 'mute'); assert.equal(view.latest.hasDiary, true)
  assert.equal(f.dream.view(at(16, 9)).latest, null, 'an old dream is not shown')
  const html = diaryHtml({ ...done, diary: { ...done.diary, opening: '<script>x</script>' } }, { name: '小芽' })
  assert.ok(!html.includes('<script>x'), 'the page escapes model text')
  assert.ok(html.includes('出处：项目「用户访谈整理」的文件 docs/说明.md'))
})

test('the night sees what the owner already decided, only from the last day; a d number counts as a leaked number', async t => {
  const f = setup(t, { complete: async (c, n) => n === 1 ? intentReply : JSON.stringify({ picked: [], dropped: [], empty: [] }) })
  // An option the owner picked: not typed words, so only the decision record carries it.
  f.dream.projects.projects.get('p_1').decisions = new Map([
    ['d_x', { id: 'd_x', threadId: 't_a', question: '邀请函用哪套视觉定稿？', options: [{ label: '深空（A 稿）' }, { label: '宣纸（B 稿）' }], chosen: 1, withdrawn: false, answeredAt: at(13, 20) }],
    ['d_old', { id: 'd_old', threadId: 't_a', question: '很久以前的问题', options: [{ label: '甲' }], chosen: 0, withdrawn: false, answeredAt: at(10, 9) }],
    ['d_open', { id: 'd_open', threadId: 't_a', question: '还没答的问题', options: [{ label: '甲' }], chosen: null, withdrawn: false }],
  ])
  await f.dream.run({ force: true })
  const input = f.calls[1].input
  assert.ok(input.includes('[d1]') && input.includes('他已经选定：宣纸（B 稿）'), 'the answered decision reaches the night with the picked label')
  assert.ok(!input.includes('很久以前的问题') && !input.includes('还没答的问题'), 'only decisions answered in the last day')
  assert.ok(leaksIds('按 d1 来') && !leaksIds('3d10 打印'), 'd numbers are material numbers too')
})
