// Mira: observations → memory → cards → the owner acts; plus the pieces the new
// UI leans on (timeline events, sub-agent rows, the dock view). No DSH needed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, COORDINATOR, MIRA, dayKey, workerKey } from '../lib/store.js'
import { Driver } from '../lib/driver.js'
import { Actions } from '../lib/actions.js'
import { MiraService } from '../lib/mira.js'
import { createTools, visibleTo } from '../lib/tools.js'
import { snapshot } from '../lib/http.js'
import { recapLabel, renderCard, renderItem, rolePrompt } from '../lib/protocol.js'

class FakeAgent {
  constructor(id, harness) {
    this.id = id
    this.harness = harness
    this.session = { id }
    this.status = 'idle'
    this.received = []
    this.idle = Promise.resolve()
    this.ctx = { systemPrompt: { section: (spec) => { this.prompt = spec.text } } }
  }
  followup(message) {
    this.received.push(message.content[0].text)
    this.idle = this.idle.then(() => this.harness.brain(this, message.content[0].text))
  }
  whenIdle() { return this.idle }
}

/** Fake timers for Mira's policy: callbacks are collected and fired by hand. */
function fakeClock() {
  const timers = new Map()
  let id = 0
  // Real "now": the store stamps events with Date.now(), and the morning check compares days.
  let now = Date.now()
  return {
    clock: {
      now: () => now,
      setTimer: (fn, ms) => { id++; timers.set(id, { fn, due: now + ms }); return id },
      clearTimer: (t) => { timers.delete(t) },
    },
    timers,
    advance(ms) {
      now += ms
      for (const [key, t] of [...timers]) if (t.due <= now) { timers.delete(key); t.fn() }
    },
    pending: () => [...timers.values()].map(t => t.due - now),
  }
}

function setup(brain, services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mira-memory-'))
  const agents = new Map()
  const harness = { brain }
  const warnings = []
  const ctx = {
    logger: { warn: (...args) => { warnings.push(args.map(String).join(' ')) } },
    agents: { withoutInitiator: fn => fn(), get: id => agents.get(id) },
    sessions: { flush: async () => true },
    get: name => services[name],
  }
  const store = new ProjectStore(dir, ctx.logger)
  store.load()
  const driver = new Driver(ctx, store, content => ({ content }))
  const actions = new Actions(store, driver)
  const tools = createTools({ defineTool: d => d, store, driver, actions })
  const fake = fakeClock()
  const mira = new MiraService(store, driver, actions, fake.clock)
  mira.start()
  driver.setController({
    async create({ sessionId }) { agents.set(sessionId, new FakeAgent(sessionId, harness)); return { sessionId } },
    async resolveAgent(sessionId) { const agent = agents.get(sessionId); return agent ? { agent } : { error: new Error('not found') } },
  })
  const call = async (agent, name, args = {}) => {
    const tool = tools.find(t => t.definition.name === name)
    assert.ok(tool, `no tool ${name}`)
    assert.ok(visibleTo(store, tool.role)({ agent }), `${name} is not visible to ${agent.id}`)
    return tool.definition.execute(args, { agent, concludeTurn() {} })
  }
  harness.call = call
  return { dir, store, driver, actions, tools, agents, call, warnings, mira, fake }
}

const settle = async (driver, ms = 1500) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 30))
    const busy = [...driver.slots.values()].some(s => s.running || s.timer !== null)
    if (!busy) return
  }
  throw new Error('driver did not settle')
}

/** Brains for the three roles: coordinator opens one thread, the worker finishes it, Mira records and hands over a card. */
function brains(env, miraSeen) {
  return async (agent) => {
    const { key } = env.store.bySession(agent.id)
    const inbox = await env.call(agent, 'inbox_read')
    if (key === COORDINATOR) {
      if (inbox.includes('trust="principal"') && inbox.includes('kind="message"') && !/mentions="记忆助理"/.test(inbox)) {
        const id = /id="(m_[0-9a-f]+)"/.exec(inbox)[1]
        await env.call(agent, 'open_thread', { title: '写回顾接口', assignee: '工程师', brief: '拆出接口', cite_message_ids: [id] })
      } else await env.call(agent, 'no_reply')
      return
    }
    if (key === MIRA) {
      miraSeen.push(inbox)
      const memory = await env.call(agent, 'memory_read')
      assert.match(memory, /现在在忙什么/)
      const seqs = [...inbox.matchAll(/seq="(\d+)"/g)].map(m => Number(m[1]))
      const review = /kind="thread_state"[^>]*thread="(t_\w+)"[^>]*state="review_ready"/.exec(inbox)
      await env.call(agent, 'memory_write', {
        now: review ? [] : [{ text: '工程师在写回顾接口', evidence_seq: [seqs[0]] }],
        open_loops: review ? [{ text: '「写回顾接口」待验收', evidence_seq: seqs }] : [],
      })
      if (review) {
        await env.call(agent, 'card_propose', { kind: 'next_step', title: '验收「写回顾接口」', body: '工程师设为待验收，看一眼就能归档。', thread_id: review[1], evidence_seq: seqs, actions: [{ id: 'open_thread' }], confidence: 0.9 })
      } else if (/mentions="记忆助理"/.test(inbox)) {
        await env.call(agent, 'memory_write', { facts: [{ text: '用户：回复只要结论', evidence_seq: [seqs[0]] }] })
        await env.call(agent, 'post_message', { text: '记下了。' })
      } else await env.call(agent, 'no_reply')
      return
    }
    if (inbox.includes('kind="thread_opened"')) {
      await env.call(agent, 'update_card', { state: 'working', summary: '在写', checklist: [{ text: '读代码', done: true }, { text: '写接口', done: false }] })
      await env.call(agent, 'update_card', { state: 'review_ready', summary: '接口写好了，在 src/recap.ts', checklist: [{ text: '读代码', done: true }, { text: '写接口', done: true }] })
    } else await env.call(agent, 'no_reply')
  }
}

test('Mira watches the project, writes memory with evidence, hands over one card, and the owner acts on it', async () => {
  const miraSeen = []
  const env = setup(async (agent) => brains(env, miraSeen)(agent))
  const { projectId } = env.actions.createProject({ name: '记忆项目' })
  const project = env.store.get(projectId)
  assert.ok(project.members.some(m => m.id === MIRA), 'Mira is a member of every project')

  env.actions.ownerPost({ projectId, text: '把回顾接口拆出来' })
  await settle(env.driver)
  const [thread] = [...project.threads.values()]
  assert.equal(thread.state, 'review_ready')
  // review_ready is urgent for Mira: a short timer, not the quiet three minutes.
  assert.ok(env.fake.pending().some(ms => ms <= 15_000), `pending timers: ${env.fake.pending()}`)
  env.fake.advance(15_000)
  await settle(env.driver)

  assert.equal(miraSeen.length, 1)
  assert.match(miraSeen[0], /kind="thread_opened"/)
  assert.match(miraSeen[0], /kind="thread_state"[^>]*state="review_ready"/)
  assert.equal(project.memory.openLoops.length, 1)
  assert.ok(project.memory.openLoops[0].evidence.length > 0)
  const cards = [...project.cards.values()]
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'next_step')
  assert.equal(cards[0].threadId, thread.id)
  assert.deepEqual(cards[0].actions.map(a => a.id), ['open_thread'])

  // The owner opens the thread from the card; Mira sees that as an observation next time.
  const acted = env.actions.cardAction({ projectId, cardId: cards[0].id, actionId: 'open_thread' })
  assert.equal(acted.action.id, 'open_thread')
  assert.equal(project.cards.get(cards[0].id).state, 'acted')
  assert.throws(() => env.actions.cardAction({ projectId, cardId: cards[0].id, actionId: 'dismiss' }), /已经处理过了/)
  assert.ok(env.store.unread(project, MIRA).some(e => e.type === 'card.acted'))

  // Snapshot carries memory, cards, Mira's status and the dock view.
  const snap = snapshot(env.store, env.driver, projectId)
  assert.equal(snap.project.memory.openLoops[0].text, '「写回顾接口」待验收')
  assert.equal(snap.project.cards[0].state, 'acted')
  assert.equal(snap.dock.cards.length, 0)
  assert.equal(snap.dock.review.length, 1)
  assert.equal(snap.dock.review[0].title, '写回顾接口')
  assert.equal(snap.project.mira.sessionId, project.sessions.get(MIRA).sessionId)
  // Timeline event lines: opened, state changes.
  const events = snap.project.threads[0].timeline.filter(r => r.kind === 'event').map(r => r.text)
  assert.ok(events.some(t => /开出任务，交给工程师/.test(t)), events.join('|'))
  assert.ok(events.some(t => /待验收/.test(t)), events.join('|'))
  assert.deepEqual(env.warnings, [])
})

test('@Mira in the chat wakes Mira alone: she records a fact and answers once, the coordinator stays quiet', async () => {
  const miraSeen = []
  const env = setup(async (agent) => brains(env, miraSeen)(agent))
  const { projectId } = env.actions.createProject({ name: '点名' })
  env.actions.ownerPost({ projectId, text: '@Mira 记一下：回复只要结论' })
  await settle(env.driver)
  const project = env.store.get(projectId)
  assert.equal(project.threads.size, 0, 'nothing to delegate')
  assert.ok(!project.sessions.has(COORDINATOR), 'a message to Mira alone never reaches the coordinator')
  assert.equal(project.memory.facts.length, 1)
  assert.equal(project.memory.facts[0].text, '用户：回复只要结论')
  const last = project.messages.get(project.chat.at(-1))
  assert.equal(last.author.id, MIRA)
  assert.equal(last.text, '记下了。')
  // Naming both brings the coordinator in; the chat still gets one answer because the brains defer to Mira.
  env.actions.ownerPost({ projectId, text: '@协调员 @Mira 现在有什么等我？' })
  await settle(env.driver)
  assert.ok(project.sessions.has(COORDINATOR))
  assert.deepEqual(env.warnings, [])
})

test("Mira's cards go stale by themselves when the thing they point at happens", async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '过时卡片' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '把样式定下来' })
  const { threadId } = env.actions.openThread(project, { title: '卡片样式', brief: '出样式', assignee: '设计师' })
  const key = workerKey(threadId)
  const { decisionId } = env.actions.requestDecision(project, key, { question: '单列还是瀑布流？', options: [{ label: '单列' }, { label: '瀑布流' }], recommended: 0 })
  const decision = project.decisions.get(decisionId)
  assert.equal(project.threads.get(threadId).state, 'blocked')
  // Two "reply" actions collapse into one button.
  const waiting = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '选卡片布局', body: '设计师等你拍板。', thread_id: threadId, evidence_seq: [decision.seq], actions: [{ id: 'reply', text: '单列' }, { id: 'reply', text: '瀑布流' }] })
  assert.deepEqual(project.cards.get(waiting.cardId).actions.map(a => a.id), ['open_thread', 'reply'])
  env.actions.answerDecision({ projectId, decisionId, chosen: 1 })
  assert.equal(project.cards.get(waiting.cardId).state, 'stale')
  assert.equal(project.cards.get(waiting.cardId).closedNote, '已拍板')
  // A next_step about the delivery goes stale when the owner accepts the thread; a card about another thread does not.
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '两版做完' })
  // The card cites the delivery (its newest fact); citing only the answered decision would be refused as a stale snapshot.
  const delivered = project.events.findLast(e => e.type === 'thread.updated' && e.threadId === threadId).seq
  const review = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收卡片样式', thread_id: threadId, evidence_seq: [decision.seq, delivered] })
  const { threadId: other } = env.actions.openThread(project, { title: '查资料', brief: '查', assignee: '研究员' })
  const elsewhere = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '资料还没查', thread_id: other, evidence_seq: [2] })
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done', resolved: true })
  assert.equal(project.cards.get(review.cardId).state, 'stale')
  assert.equal(project.cards.get(review.cardId).closedNote, '线程已归档')
  assert.equal(project.cards.get(elsewhere.cardId).state, 'open')
  assert.equal(env.store.openCards(project).length, 1)
  // Recaps describe the past, so they survive the thread they mention.
  const second = env.actions.createProject({ name: '过时卡片 · 回顾' })
  const p2 = env.store.get(second.projectId)
  env.actions.ownerPost({ projectId: p2.id, text: '开工' })
  const t2 = env.actions.openThread(p2, { title: '写接口', brief: '写', assignee: '工程师' })
  const recap = env.actions.proposeCard(p2, MIRA, { kind: 'recap', title: '今天小结', body: '开了一个线程。', thread_id: t2.threadId, evidence_seq: [2] })
  env.actions.ownerUpdateThread({ projectId: p2.id, threadId: t2.threadId, state: 'done', resolved: true })
  assert.equal(p2.cards.get(recap.cardId).state, 'open')
  // The snapshot carries the state and the note; the dock no longer lists the answered decision; replay agrees.
  const snap = snapshot(env.store, env.driver, projectId)
  assert.equal(snap.project.cards.find(c => c.id === waiting.cardId).state, 'stale')
  assert.equal(snap.project.cards.find(c => c.id === waiting.cardId).closedNote, '已拍板')
  assert.equal(snap.project.cards.find(c => c.id === review.cardId).closedNote, '线程已归档')
  assert.equal(snap.dock.waiting.length, 0)
  const again = new ProjectStore(env.dir, { warn() {} })
  again.load()
  assert.equal(again.get(projectId).cards.get(review.cardId).state, 'stale')
  assert.equal(again.get(projectId).cards.get(review.cardId).closedNote, '线程已归档')
  await settle(env.driver)
})

test('cards: evidence is required, twins are superseded, three a day, and Mira can withdraw', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '卡片规则' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '随便说一句' })
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '无证据', evidence_seq: [] }), /evidence_seq 不能为空/)
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'bogus', title: 'x', evidence_seq: [2] }), /kind 只能是/)
  assert.throws(() => env.actions.proposeCard(project, COORDINATOR, { kind: 'reminder', title: 'x', evidence_seq: [2] }), /只有记忆助理/)
  const a = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '记得验收', evidence_seq: [2] })
  const b = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '记得验收', evidence_seq: [2] })
  assert.equal(b.superseded, a.cardId)
  assert.equal(project.cards.get(a.cardId).state, 'superseded')
  env.actions.proposeCard(project, MIRA, { kind: 'recap', title: '今天小结', evidence_seq: [2] })
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'capture', title: '再来一张', evidence_seq: [2] }), /3 张卡/)
  // The morning card is outside the daily budget.
  const morning = env.actions.proposeCard(project, MIRA, { kind: 'morning', title: '早安回顾', evidence_seq: [] })
  assert.equal(project.cards.get(morning.cardId).kind, 'morning')
  env.actions.withdrawCard(project, MIRA, b.cardId, '已经验收了')
  assert.equal(project.cards.get(b.cardId).state, 'withdrawn')
  assert.equal(env.store.openCards(project).length, 2)
  // Replay keeps the same card states.
  const again = new ProjectStore(env.dir, { warn() {} })
  again.load()
  assert.equal(again.get(projectId).cards.get(b.cardId).state, 'withdrawn')
  assert.equal(again.openCards(again.get(projectId)).length, 2)
})

test('bug 7: a next_step about a decision already withdrawn is refused on arrival, and the inbox item says so', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '过期快照 · 作废' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '接口怎么做' })
  const { threadId } = env.actions.openThread(project, { title: '数据接口', brief: '写接口', assignee: '工程师' })
  const key = workerKey(threadId)
  const { decisionId } = env.actions.requestDecision(project, key, { question: 'REST 还是 GraphQL？', options: [{ label: 'REST' }, { label: 'GraphQL' }], recommended: 0 })
  const decision = project.decisions.get(decisionId)
  env.actions.withdrawDecision(project, key, { decision_id: decisionId, reason: '需求改了' })
  // Mira read her inbox before the withdrawal and proposes from that snapshot: refused, with the reason, and nothing lands.
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '等你拍板', thread_id: threadId, evidence_seq: [decision.seq], actions: [{ id: 'open_thread' }] }), /已作废（需求改了）/)
  assert.equal(project.cardOrder.length, 0)
  assert.equal(env.store.openCards(project).length, 0)
  // Rendered now, the old inbox item carries the outcome.
  const requested = project.events.find(e => e.type === 'decision.requested' && e.decisionId === decisionId)
  const item = renderItem(project, requested)
  assert.match(item, /state="withdrawn"/)
  assert.match(item, /后来已作废：需求改了/)
  // A recap may still cite the decision: it describes the past.
  const recap = env.actions.proposeCard(project, MIRA, { kind: 'recap', title: '今天小结', body: '接口问题作废了。', evidence_seq: [decision.seq] })
  assert.equal(project.cards.get(recap.cardId).state, 'open')
  await settle(env.driver)
})

test('bug 7: a next_step about an answered decision, or about a finished thread, is refused on arrival', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '过期快照 · 已答' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '分页怎么做' })
  const { threadId } = env.actions.openThread(project, { title: '数据接口', brief: '写接口', assignee: '工程师' })
  const key = workerKey(threadId)
  const { decisionId } = env.actions.requestDecision(project, key, { question: '游标还是页码？', options: [{ label: '游标' }, { label: '页码' }], recommended: 0 })
  const decision = project.decisions.get(decisionId)
  env.actions.answerDecision({ projectId, decisionId, chosen: 0 })
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '等你拍板', thread_id: threadId, evidence_seq: [decision.seq] }), /已经选了「游标」/)
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '分页还没定', evidence_seq: [2, decision.seq] }), /已经选了「游标」/)
  // Citing the answer itself (a newer fact) is a different card: it is about what happened, so it is let through.
  const answered = project.events.findLast(e => e.type === 'decision.answered').seq
  const after = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '按游标继续', thread_id: threadId, evidence_seq: [decision.seq, answered] })
  assert.equal(project.cards.get(after.cardId).state, 'open')
  env.actions.withdrawCard(project, MIRA, after.cardId, '测试用')
  const item = renderItem(project, project.events.find(e => e.type === 'decision.requested' && e.decisionId === decisionId))
  assert.match(item, /state="answered"/)
  assert.match(item, /后来已选「游标」/)
  // A card about the thread itself is still fine while the thread is alive...
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '接口写好了' })
  const review = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收「数据接口」', thread_id: threadId, evidence_seq: [2] })
  assert.equal(project.cards.get(review.cardId).state, 'open')
  // ...and refused once the owner has accepted and archived it; the stale rule still closes the earlier card.
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done', resolved: true })
  assert.equal(project.cards.get(review.cardId).state, 'stale')
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收「数据接口」', thread_id: threadId, evidence_seq: [2] }), /已经归档/)
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '记得看接口', thread_id: threadId, evidence_seq: [2] }), /已经归档/)
  // A worker-finished (done, not yet archived) thread counts too; a recap about it does not.
  const second = env.actions.openThread(project, { title: '写文档', brief: '写', assignee: '研究员' })
  env.actions.updateCard(project, workerKey(second.threadId), { state: 'done', summary: '写完了' })
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '看文档', thread_id: second.threadId, evidence_seq: [2] }), /已经完成/)
  const recap = env.actions.proposeCard(project, MIRA, { kind: 'recap', title: '今天小结', body: '文档写完了。', thread_id: second.threadId, evidence_seq: [2] })
  assert.equal(project.cards.get(recap.cardId).state, 'open')
  // Replay agrees: refused cards left no trace.
  const again = new ProjectStore(env.dir, { warn() {} })
  again.load()
  assert.equal(again.get(projectId).cardOrder.length, 3)
  await settle(env.driver)
})

test('memory entries need evidence; the owner can forget one; save_memory from a card adds a fact', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '记忆规则' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '以后截图都放 evidence 里' })
  assert.throws(() => env.actions.writeMemory(project, MIRA, { facts: [{ text: '没证据' }] }), /没有 evidence_seq/)
  env.actions.writeMemory(project, MIRA, { facts: [{ text: '截图放 evidence', evidence_seq: [2] }], now: [{ text: '没在忙', evidence_seq: [2] }] })
  assert.equal(project.memory.facts.length, 1)
  assert.equal(project.memory.now.length, 1)
  // Sections that are not passed stay as they were.
  env.actions.writeMemory(project, MIRA, { now: [] })
  assert.equal(project.memory.facts.length, 1)
  assert.equal(project.memory.now.length, 0)
  const card = env.actions.proposeCard(project, MIRA, { kind: 'capture', title: '记一下？', evidence_seq: [2], actions: [{ id: 'save_memory', text: '用户喜欢短回复' }] })
  env.actions.cardAction({ projectId, cardId: card.cardId, actionId: 'save_memory' })
  assert.equal(project.memory.facts.at(-1).text, '用户喜欢短回复')
  env.actions.memoryForget({ projectId, section: 'facts', index: 0 })
  assert.deepEqual(project.memory.facts.map(f => f.text), ['用户喜欢短回复'])
  assert.throws(() => env.actions.memoryForget({ projectId, section: 'nope', index: 0 }), /没有这一栏/)
})

test('Mira sees only her tools, workers never see memory tools, and the morning card fires once a day after activity', async () => {
  const env = setup(async (agent) => { await env.call(agent, 'inbox_read'); await env.call(agent, 'no_reply') })
  const { projectId } = env.actions.createProject({ name: '权限与早安' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '在吗' })
  env.actions.ownerPost({ projectId, text: '今天先把接口拆出来' })
  env.actions.ownerPost({ projectId, text: '样式明天再说' })
  await settle(env.driver)
  env.actions.miraRun({ projectId })
  await settle(env.driver)
  const miraAgent = env.agents.get(project.sessions.get(MIRA).sessionId)
  const coordAgent = env.agents.get(project.sessions.get(COORDINATOR).sessionId)
  const names = role => env.tools.filter(t => visibleTo(env.store, t.role)({ agent: role })).map(t => t.definition.name).sort()
  assert.ok(names(miraAgent).includes('memory_write'))
  assert.ok(names(miraAgent).includes('card_propose'))
  assert.ok(!names(miraAgent).includes('update_card'))
  assert.ok(!names(miraAgent).includes('open_thread'))
  assert.ok(!names(coordAgent).includes('memory_write'))
  assert.match(miraAgent.prompt, /你不接活，只看、记、提醒/)
  assert.match(rolePrompt(project, workerKey('t_x')), /subagent 工具开子代理/)
  // Owner-requested run woke Mira with the request marked.
  assert.match(miraAgent.received[0], /request="owner"/)

  // Morning: never for a project that just started, then once per day with a few settled events
  // (the test host's local hour is past 6 or we skip the clock gate).
  assert.equal(env.mira.maybeMorning(project), false, 'a project a few seconds old has nothing to recap')
  for (const e of project.events) e.at = env.fake.clock.now() - 2 * 3600e3 // "activity two hours ago"
  const early = new Date(env.fake.clock.now()).getHours() < 6
  assert.equal(env.mira.maybeMorning(project), !early)
  // The recap is "morning" only in the morning.
  assert.equal(recapLabel(new Date(2026, 0, 1, 9).getTime()), '早安回顾')
  assert.equal(recapLabel(new Date(2026, 0, 1, 15).getTime()), '今日回顾')
  assert.equal(recapLabel(new Date(2026, 0, 1, 20).getTime()), '晚间回顾')
  if (early) env.actions.miraRun({ projectId, reason: 'morning' })
  assert.equal(project.morningDay, dayKey(Date.now()))
  assert.equal(env.mira.maybeMorning(project), false, 'already asked today')
  await settle(env.driver)
  assert.match(miraAgent.received.at(-1), /request="morning"/)
  assert.deepEqual(env.warnings, [])
})

test('sub-agent rows come from the subagents service and land on the thread card', async () => {
  const listed = []
  const runtime = { async listChildren(parent) { listed.push(parent); return parent.startsWith('child-') ? [] : [{ id: 'child-1', mode: 'continuable', label: '查文档', createdAt: 1 }, { id: 'child-2', mode: 'one-shot' }] } }
  const env = setup(async (agent) => {
    const { key } = env.store.bySession(agent.id)
    const inbox = await env.call(agent, 'inbox_read')
    if (key === COORDINATOR && inbox.includes('trust="principal"')) {
      await env.call(agent, 'open_thread', { title: '查资料', assignee: '研究员', brief: '查', cite_message_ids: [/id="(m_[0-9a-f]+)"/.exec(inbox)[1]] })
    } else await env.call(agent, 'no_reply')
  }, { subagents: runtime })
  const { projectId } = env.actions.createProject({ name: '子代理' })
  env.actions.ownerPost({ projectId, text: '查一下' })
  await settle(env.driver)
  const project = env.store.get(projectId)
  const [thread] = [...project.threads.values()]
  const sessionId = project.sessions.get(workerKey(thread.id)).sessionId
  env.agents.get('child-1') // not a live agent → not running
  await env.driver.refreshChildren([sessionId])
  assert.deepEqual(listed, [sessionId, 'child-1', 'child-2'])
  const snap = snapshot(env.store, env.driver, projectId)
  assert.deepEqual(snap.project.threads[0].children.map(c => [c.id, c.mode, c.label, c.running]), [['child-1', 'continuable', '查文档', false], ['child-2', 'one-shot', '', false]])
  // Cached: a second refresh inside the TTL does not call the service again.
  await env.driver.refreshChildren([sessionId])
  assert.equal(listed.length, 3)
  assert.deepEqual(env.warnings, [])
})

test('bug 9: a card that only mentions a decision among older evidence survives the answer; the card about it goes stale', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '误过时' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '接口和样式一起做' })
  const api = env.actions.openThread(project, { title: '数据接口', brief: '写接口', assignee: '工程师' })
  const ui = env.actions.openThread(project, { title: '卡片样式', brief: '出样式', assignee: '设计师' })
  const { decisionId } = env.actions.requestDecision(project, workerKey(api.threadId), { question: '游标还是页码？', options: [{ label: '游标' }, { label: '页码' }], recommended: 0 })
  const decision = project.decisions.get(decisionId)
  // The designer delivers after the engineer asked; Mira's card about the designer thread cites both facts.
  env.actions.updateCard(project, workerKey(ui.threadId), { state: 'review_ready', summary: '样式出了两版' })
  const delivered = project.events.findLast(e => e.type === 'thread.updated' && e.threadId === ui.threadId).seq
  const aboutUi = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收卡片样式', thread_id: ui.threadId, evidence_seq: [decision.seq, delivered] })
  const aboutDecision = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '选分页方式', thread_id: api.threadId, evidence_seq: [2, decision.seq] })
  const recap = env.actions.proposeCard(project, MIRA, { kind: 'recap', title: '今天小结', body: '工程师在等分页拍板。', evidence_seq: [decision.seq] })
  env.actions.answerDecision({ projectId, decisionId, chosen: 0 })
  // run-07: the designer card went stale because it cited the engineer decision. Only the card whose newest fact is the decision closes.
  assert.equal(project.cards.get(aboutDecision.cardId).state, 'stale')
  assert.equal(project.cards.get(aboutDecision.cardId).closedNote, '已拍板')
  assert.equal(project.cards.get(aboutUi.cardId).state, 'open')
  assert.equal(project.cards.get(recap.cardId).state, 'open')
  assert.deepEqual(env.store.openCards(project).map(c => c.id).sort(), [aboutUi.cardId, recap.cardId].sort())
  // The dock still shows the designer's delivery as waiting for the owner; replay agrees.
  const snap = snapshot(env.store, env.driver, projectId)
  assert.equal(snap.project.cards.find(c => c.id === aboutUi.cardId).state, 'open')
  assert.equal(snap.project.cards.find(c => c.id === aboutDecision.cardId).closedNote, '已拍板')
  const again = new ProjectStore(env.dir, { warn() {} })
  again.load()
  assert.equal(again.get(projectId).cards.get(aboutUi.cardId).state, 'open')
  assert.equal(again.get(projectId).cards.get(aboutDecision.cardId).state, 'stale')
  await settle(env.driver)
})

test('bug 11: settling a decision leaves alone a card written before the decision existed (r31: the review card itself goes when the question pulls the thread back to 「等你」)', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '拍板前的验收卡' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '出一版样式' })
  const { threadId } = env.actions.openThread(project, { title: '出卡片流样式', brief: '出样式', assignee: '设计师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '三版已出' })
  const delivered = project.events.findLast(e => e.type === 'thread.updated' && e.threadId === threadId).seq
  const review = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收卡片流样式', thread_id: threadId, evidence_seq: [delivered] })
  const earlier = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '截图下一版再加', thread_id: threadId, evidence_seq: [delivered] })
  // Later the designer asks a question in the same thread and the owner changes the requirement: the question goes, the card
  // written before the question stays. r31: the review card itself went the moment the question pulled the thread back to 「等你」.
  await new Promise(r => setTimeout(r, 5))
  const { decisionId } = env.actions.requestDecision(project, key, { question: '圆角 8 还是 12？', options: [{ label: '8' }, { label: '12' }], recommended: 0 })
  assert.equal(project.cards.get(review.cardId).state, 'stale')
  assert.equal(project.cards.get(review.cardId).closedNote, '线程回到「等你」：执行者又发了拍板')
  assert.equal(project.cards.get(earlier.cardId).state, 'open')
  const decision = project.decisions.get(decisionId)
  const waiting = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '圆角还没定', thread_id: threadId, evidence_seq: [decision.seq] })
  env.actions.withdrawDecision(project, key, { decision_id: decisionId, reason: '不要圆角了' })
  assert.equal(project.cards.get(waiting.cardId).state, 'stale')
  assert.equal(project.cards.get(earlier.cardId).state, 'open')
  // Same for an answered decision: the card written after the question is moot, the earlier review card is not.
  // (A second next_step on the same thread would supersede the review card by design, so this one is an open_loop.)
  const second = env.actions.requestDecision(project, key, { question: '细线还是粗线？', options: [{ label: '细' }, { label: '粗' }], recommended: 0 })
  const d2 = project.decisions.get(second.decisionId)
  const waiting2 = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '线宽还没定', thread_id: threadId, evidence_seq: [d2.seq] })
  env.actions.answerDecision({ projectId, decisionId: second.decisionId, chosen: 1 })
  assert.equal(project.cards.get(waiting2.cardId).state, 'stale')
  assert.equal(project.cards.get(earlier.cardId).state, 'open')
  // Acceptance still closes everything about the thread.
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done', resolved: true })
  assert.equal(project.cards.get(earlier.cardId).state, 'stale')
  assert.equal(project.cards.get(earlier.cardId).closedNote, '线程已归档')
  assert.equal(project.cards.get(review.cardId).closedNote, '线程回到「等你」：执行者又发了拍板', '早就撤了的卡不再改原因')
  await settle(env.driver)
})

test('bug 12: cards the platform retired, or Mira withdrew, give their daily slot back', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '每日额度' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  const { threadId } = env.actions.openThread(project, { title: '写接口', brief: '写', assignee: '工程师' })
  const key = workerKey(threadId)
  const { decisionId } = env.actions.requestDecision(project, key, { question: '游标还是页码？', options: [{ label: '游标' }, { label: '页码' }], recommended: 0 })
  const decision = project.decisions.get(decisionId)
  env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '选分页方式', thread_id: threadId, evidence_seq: [decision.seq] })
  env.actions.proposeCard(project, MIRA, { kind: 'recap', title: '今天小结', evidence_seq: [2] })
  const third = env.actions.proposeCard(project, MIRA, { kind: 'capture', title: '记一下', evidence_seq: [2] })
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '第四张', evidence_seq: [2] }), /3 张卡/)
  // The decision is answered: the platform retires the first card, and Mira may put a fresh one in its place.
  env.actions.answerDecision({ projectId, decisionId, chosen: 0 })
  const fresh = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '按游标继续', thread_id: threadId, evidence_seq: [project.events.at(-1).seq] })
  assert.equal(project.cards.get(fresh.cardId).state, 'open')
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '第五张', evidence_seq: [2] }), /3 张卡/)
  // Withdrawing her own card frees a slot too, as the error message promises.
  env.actions.withdrawCard(project, MIRA, third.cardId, '不用记了')
  const again = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '第五张', evidence_seq: [2] })
  assert.equal(project.cards.get(again.cardId).state, 'open')
  await settle(env.driver)
})

test('bug 13: delivering again after a decision or a rework keeps the cards from the first delivery, except the review card a question already retired (r31)', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '再次交付' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '出一版样式' })
  const { threadId } = env.actions.openThread(project, { title: '出卡片流样式', brief: '出样式', assignee: '设计师' })
  const key = workerKey(threadId)
  // A card from the working phase still goes stale at the first delivery.
  const waitingFor = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '等样式交付', thread_id: threadId, evidence_seq: [project.events.at(-1).seq] })
  await new Promise(r => setTimeout(r, 5))
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '三版已出' })
  assert.equal(project.cards.get(waitingFor.cardId).state, 'stale')
  const delivered = project.events.findLast(e => e.type === 'thread.updated' && e.threadId === threadId).seq
  const review = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收卡片流样式', thread_id: threadId, evidence_seq: [delivered] })
  const fromReview = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '截图还没加', thread_id: threadId, evidence_seq: [delivered] }) // not a reminder: the rework reminder below would supersede it
  await new Promise(r => setTimeout(r, 5))
  // The designer asks about corners (the thread blocks; r31: the review card goes, the reminder from that phase stays),
  // the owner drops the question, she delivers the square version.
  const { decisionId } = env.actions.requestDecision(project, key, { question: '圆角 8 还是 12？', options: [{ label: '8' }, { label: '12' }], recommended: 0 })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  assert.equal(project.cards.get(review.cardId).state, 'stale')
  assert.equal(project.cards.get(fromReview.cardId).state, 'open')
  env.actions.withdrawDecision(project, key, { decision_id: decisionId, reason: '不要圆角了' })
  await new Promise(r => setTimeout(r, 5))
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '改成直角，三版已出' })
  assert.equal(project.cards.get(fromReview.cardId).state, 'open')
  // Rework after that: a card from the rework phase is retired by the next delivery, the review card is not.
  env.actions.updateCard(project, key, { state: 'working', summary: '返工中' })
  await new Promise(r => setTimeout(r, 5))
  const rework = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '等返工', thread_id: threadId, evidence_seq: [project.events.at(-1).seq] })
  await new Promise(r => setTimeout(r, 5))
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '返工完' })
  assert.equal(project.cards.get(rework.cardId).state, 'stale')
  assert.equal(project.cards.get(fromReview.cardId).state, 'open')
  // Acceptance still closes everything, and a replay agrees.
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done', resolved: true })
  assert.equal(project.cards.get(fromReview.cardId).state, 'stale')
  await settle(env.driver)
  const again = new ProjectStore(env.dir, { warn() {} })
  again.load()
  assert.equal(again.get(projectId).cards.get(fromReview.cardId).state, 'stale')
  assert.equal(again.get(projectId).cards.get(rework.cardId).state, 'stale')
  assert.equal(again.get(projectId).cards.get(review.cardId).closedNote, '线程回到「等你」：执行者又发了拍板')
})

test('bug 14: a dropped question puts the thread back where it was, an answered one puts it to work', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '拍板后的状态' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '出一版样式' })
  const { threadId } = env.actions.openThread(project, { title: '出卡片流样式', brief: '出样式', assignee: '设计师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '两版已出' })
  // A delivered thread asks about corners; the owner drops the requirement: the thread is still delivered.
  const first = env.actions.requestDecision(project, key, { question: '圆角 8 还是 12？', options: [{ label: '8' }, { label: '12' }], recommended: 0 })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  env.actions.withdrawDecision(project, key, { decision_id: first.decisionId, reason: '不要圆角了' })
  assert.equal(project.threads.get(threadId).state, 'review_ready')
  // Answered, the worker has something to do.
  const second = env.actions.requestDecision(project, key, { question: '边线 1px 还是不要？', options: [{ label: '1px' }, { label: '不要' }], recommended: 0 })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  env.actions.answerDecision({ projectId, decisionId: second.decisionId, chosen: 1 })
  assert.equal(project.threads.get(threadId).state, 'working')
  // A thread the worker blocked by hand, then asked from, goes back to working when the question is dropped.
  env.actions.updateCard(project, key, { state: 'blocked', summary: '等素材' })
  const third = env.actions.requestDecision(project, key, { question: '素材用 A 还是 B？', options: [{ label: 'A' }, { label: 'B' }], recommended: 0 })
  env.actions.withdrawDecision(project, key, { decision_id: third.decisionId, reason: '素材到了' })
  assert.equal(project.threads.get(threadId).state, 'working')
  await settle(env.driver)
  const again = new ProjectStore(env.dir, { warn() {} })
  again.load()
  assert.equal(again.get(projectId).threads.get(threadId).state, 'working')
})

test('bug 15: two questions wait at once; the thread stays blocked until both are settled', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '两张拍板' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '拆接口' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆接口', assignee: '工程师' })
  const key = workerKey(threadId)
  const paging = env.actions.requestDecision(project, key, { question: '分页用游标还是页码？', options: [{ label: '游标' }, { label: '页码' }], recommended: 0 })
  const format = env.actions.requestDecision(project, key, { question: '时间字段用 ISO 还是毫秒？', options: [{ label: 'ISO' }, { label: '毫秒' }], recommended: 0 })
  assert.deepEqual(format.replaced, [])
  assert.deepEqual(format.pending, [paging.decisionId])
  assert.equal(project.decisions.get(paging.decisionId).withdrawn, false)
  assert.equal(env.store.pendingDecisions(project, threadId).length, 2)
  // Answering one keeps the thread waiting on the other.
  env.actions.answerDecision({ projectId, decisionId: format.decisionId, chosen: 0 })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  env.actions.answerDecision({ projectId, decisionId: paging.decisionId, chosen: 1 })
  assert.equal(project.threads.get(threadId).state, 'working')
  // The same question asked again (punctuation aside) replaces its older copy, nothing else.
  const a = env.actions.requestDecision(project, key, { question: '缓存多久？', options: [{ label: '1 分钟' }, { label: '10 分钟' }], recommended: 0 })
  const b = env.actions.requestDecision(project, key, { question: '返回几条？', options: [{ label: '20' }, { label: '50' }], recommended: 0 })
  const c = env.actions.requestDecision(project, key, { question: '缓存多久?', options: [{ label: '1 分钟' }, { label: '10 分钟' }], recommended: 1 })
  assert.deepEqual(c.replaced, [a.decisionId])
  assert.deepEqual(c.pending, [b.decisionId])
  assert.equal(project.decisions.get(a.decisionId).withdrawReason, '被新的拍板替换')
  assert.equal(project.decisions.get(b.decisionId).withdrawn, false)
  assert.equal(env.store.pendingDecisions(project, threadId).length, 2)
  await settle(env.driver)
})

test('bug 16: a worker cannot flip a thread with an open question back to working', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '等你的时候' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '拆接口' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆接口', assignee: '工程师' })
  const key = workerKey(threadId)
  const { decisionId } = env.actions.requestDecision(project, key, { question: '分页用游标还是页码？', options: [{ label: '游标' }, { label: '页码' }], recommended: 0 })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  // Everyone who lists threads sees the open question on the card (r10); the coordinator is not told otherwise.
  assert.match(renderCard(project, project.threads.get(threadId)), /<decisions>等用户答「分页用游标还是页码？」<\/decisions>/)
  // The engineer keeps busy on other parts: the summary lands, the state stays 「等你」.
  const patch = env.actions.updateCard(project, key, { state: 'working', summary: '先把时间字段改了' })
  assert.deepEqual(patch, { summary: '先把时间字段改了' })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  assert.equal(project.threads.get(threadId).summary, '先把时间字段改了')
  // The dropped field is on the record, so a run's event log shows the guard fired (r9) and the inbox says why.
  assert.deepEqual(project.events.at(-1).ignored, ['state'])
  assert.match(renderItem(project, project.events.at(-1)), /更新了摘要.*还有没答的拍板，状态保持「等你」/)
  // Nothing to apply, still recorded; the event wakes nobody.
  const before = project.events.length
  assert.deepEqual(env.actions.updateCard(project, key, { state: 'working' }), {})
  assert.equal(project.events.length, before + 1)
  const held = project.events.at(-1)
  assert.equal(held.type, 'thread.updated')
  assert.deepEqual(held.patch, {})
  assert.deepEqual(held.ignored, ['state'])
  assert.deepEqual(held.to, [])
  // r24: the same request again is a repeat — the inbox item only says the card did not change, the timeline keeps
  // the first row (cloud-run-21 #161 / #176 showed 「保持等你」 twice and Mira read it as 「线程改回进行中」).
  assert.equal(held.repeat, true)
  assert.match(renderItem(project, held), /kind="card_held".*卡片没有变化/)
  assert.doesNotMatch(renderItem(project, held), /想改回「进行中」/)
  // The owner sees it on the thread's timeline (r10), so a run's snapshot can count it too.
  const rows = snapshot(env.store, env.driver, projectId).project.threads.find(t => t.id === threadId).timeline.filter(r => r.kind === 'event' && r.held)
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /想把状态改回「进行中」，还有没答的拍板，保持「等你」/)
  // Answered, the thread works; blocked by hand without a question, the worker may unblock it, and nothing is ignored.
  env.actions.answerDecision({ projectId, decisionId, chosen: 0 })
  assert.equal(project.threads.get(threadId).state, 'working')
  assert.match(renderCard(project, project.threads.get(threadId)), /已拍板「分页用游标还是页码？」→ 游标/)
  env.actions.updateCard(project, key, { state: 'blocked', summary: '等素材' })
  env.actions.updateCard(project, key, { state: 'working', summary: '素材到了' })
  assert.equal(project.threads.get(threadId).state, 'working')
  assert.equal(project.events.at(-1).ignored, undefined)
  await settle(env.driver)
})

test('bug 18: a worker cannot deliver a thread while its own question still waits; withdrawing it first can', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '交付前先收题' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '拆接口' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆接口', assignee: '工程师' })
  const key = workerKey(threadId)
  const { decisionId } = env.actions.requestDecision(project, key, { question: '分页用游标还是页码？', options: [{ label: '游标' }, { label: '页码' }], recommended: 0 })
  // cloud-run-09 #102: review_ready with the question open; the platform retired it as 「线程已交付待验收」 (#103).
  const patch = env.actions.updateCard(project, key, { state: 'review_ready', summary: '骨架落地，仍缺分页拍板' })
  assert.deepEqual(patch, { summary: '骨架落地，仍缺分页拍板' })
  assert.equal(project.threads.get(threadId).state, 'blocked')
  assert.equal(project.decisions.get(decisionId).withdrawn, false)
  assert.equal(project.decisions.get(decisionId).chosen, null)
  const held = project.events.at(-1)
  assert.deepEqual(held.ignored, ['state'])
  assert.equal(held.wanted, 'review_ready')
  assert.deepEqual(held.to, [])
  assert.match(renderItem(project, held), /更新了摘要.*想把线程置为「待验收」交付，但还有没答的拍板，状态保持「等你」/)
  const rows = snapshot(env.store, env.driver, projectId).project.threads.find(t => t.id === threadId).timeline.filter(r => r.kind === 'event' && r.held)
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /想直接交付「待验收」，还有没答的拍板，保持「等你」/)
  assert.match(renderCard(project, project.threads.get(threadId)), /<decisions>等用户答「分页用游标还是页码？」<\/decisions>/)
  // The author withdraws the question with a reason; now the delivery goes through and the coordinator is told.
  env.actions.withdrawDecision(project, key, { decision_id: decisionId, reason: 'v1 不依赖分页，先交付' })
  assert.equal(project.threads.get(threadId).state, 'working')
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付 v1' })
  assert.equal(project.threads.get(threadId).state, 'review_ready')
  assert.equal(project.events.at(-1).ignored, undefined)
  assert.deepEqual(project.events.at(-1).to, [COORDINATOR])
  assert.equal(project.decisions.get(decisionId).withdrawReason, 'v1 不依赖分页，先交付')
  // failed still retires an open question: that thread is over.
  const { threadId: other } = env.actions.openThread(project, { title: '跑基准', brief: '跑基准', assignee: '研究员' })
  const second = env.actions.requestDecision(project, workerKey(other), { question: '缺数据：模拟还是放弃？', options: [{ label: '模拟' }, { label: '放弃' }], recommended: 1 })
  env.actions.updateCard(project, workerKey(other), { state: 'failed', summary: '缺数据集' })
  assert.equal(project.threads.get(other).state, 'failed')
  assert.equal(project.decisions.get(second.decisionId).withdrawReason, '线程已失败')
  await settle(env.driver)
})

test('bug 17: Mira speaks in the chat only to answer an @Mira she has not answered yet', async () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '插话' })
  const project = env.store.get(projectId)
  // A message to the coordinator wakes Mira as an observer; she may not join the chat on it (cloud-run-06 #246).
  env.actions.ownerPost({ projectId, text: '「hello.md」我看了，收了。另外现在还有哪几件事在等我？' })
  assert.throws(() => env.actions.assistantPost(project, MIRA, '还有两件：…'), /没被点名/)
  assert.equal(project.chat.length, 1)
  // Named, she answers once; a second line on the same ask is refused.
  env.actions.ownerPost({ projectId, text: '@Mira 记一下：回复只要结论' })
  env.actions.assistantPost(project, MIRA, '记下了。')
  assert.throws(() => env.actions.assistantPost(project, MIRA, '还有一句。'), /没被点名/)
  assert.equal(project.messages.get(project.chat.at(-1)).author.id, MIRA)
  // Named together with the coordinator, both may speak; the coordinator is never held back.
  env.actions.ownerPost({ projectId, text: '@协调员 @Mira 现在有什么等我？' })
  env.actions.assistantPost(project, MIRA, '两件。')
  env.actions.assistantPost(project, COORDINATOR, '转达了。')
  // A tidy-up request from the owner's button is not a mention: memory and cards, no chat.
  env.actions.miraRun({ projectId, reason: 'owner' })
  assert.throws(() => env.actions.assistantPost(project, MIRA, '整理好了。'), /没被点名/)
  // The projection survives a replay.
  const again = new ProjectStore(env.store.root, { warn() {} })
  again.load()
  const replayed = again.get(projectId)
  assert.equal(replayed.miraAskSeq, project.miraAskSeq)
  assert.equal(replayed.miraReplySeq, project.miraReplySeq)
  await settle(env.driver)
})

test('bug 19: an @Mira answered with memory_write alone is nudged once to reply; a direct answer is not', async () => {
  let miraTurns = 0
  const env = setup(async (agent, text) => {
    const binding = env.store.bySession(agent.id)
    if (binding.key !== MIRA) return env.call(agent, 'no_reply')
    miraTurns++
    const project = env.store.get(binding.projectId)
    const asked = project.chat.map(id => project.messages.get(id)).filter(msg => msg.author.kind === 'human').at(-1)
    if (miraTurns === 1) {
      // cloud-run-10 R6 (#282–#288): she read the inbox, wrote the memory and ended the turn without a word.
      await env.call(agent, 'inbox_read')
      await env.call(agent, 'memory_write', { facts: [{ text: '用户：这俩先挂着，别催', evidence_seq: [asked.seq] }] })
      return
    }
    if (miraTurns === 2) {
      assert.match(text, /reason="unanswered"/)
      await env.call(agent, 'post_message', { text: '记下了。' })
      return
    }
    await env.call(agent, 'inbox_read')
    await env.call(agent, 'post_message', { text: '记在「关于你和项目」里。' })
  })
  const { projectId } = env.actions.createProject({ name: '没回话' })
  env.actions.ownerPost({ projectId, text: '@Mira 帮我记一句：这俩先挂着，别催。' })
  await settle(env.driver)
  let project = env.store.get(projectId)
  assert.equal(miraTurns, 2, 'the wake, then one follow-up')
  const turn = project.turns.get(MIRA)
  assert.equal(turn.silent, false)
  assert.equal(turn.nudged, true)
  assert.equal(turn.unanswered, true)
  const last = project.messages.get(project.chat.at(-1))
  assert.equal(last.author.id, MIRA)
  assert.equal(last.text, '记下了。')
  assert.equal(project.memory.facts.length, 1)
  // Answering straight away: no follow-up, nothing recorded.
  env.actions.ownerPost({ projectId, text: '@Mira 你记到哪了？' })
  await settle(env.driver)
  project = env.store.get(projectId)
  assert.equal(miraTurns, 3)
  assert.equal(project.turns.get(MIRA).nudged, false)
  assert.equal(project.turns.get(MIRA).unanswered, false)
})

test('bug 20: the coordinator prompt treats 「收了、关掉」 as acceptance to relay and only 「算了、归档吧」 as archiving', () => {
  // cloud-run-11 P5: r14's sentence 「归档只有用户能做…」 made the coordinator answer 「剩下只用你在那张卡上点『归档』」 to
  // 「这张我收了，把卡片关掉」 and skip the relay; the thread stayed review_ready for 600 s.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '措辞' })
  const prompt = rolePrompt(env.store.get(projectId), COORDINATOR)
  const accept = prompt.indexOf('是验收：照旧用 message_thread 转给负责人')
  const archive = prompt.indexOf('只有用户明确说「算了、不做了、归档吧」才是归档')
  assert.ok(accept > 0 && archive > accept, '验收那句在前，归档那句只认「算了 / 不做了 / 归档吧」')
  assert.ok(!/用户说「算了、归档吧」时，回一句告诉他/.test(prompt), 'r14 的旧措辞已去掉')
  // r18 (cloud-run-15 #283): the closing notice must not re-list what still waits right after the coordinator answered it.
  assert.match(prompt, /已完成：多半是他刚验收过、你也刚说过在收尾，不再通报，直接 no_reply/)
})

test('bug 21: the worker prompt says a chat question the coordinator relayed along is his to answer, not to relay back', () => {
  // cloud-run-13 P5: after setting done the designer relayed 「用户还问了『现在还有哪几件事在等我』…请协调员汇总回答」 (#285)
  // and the coordinator answered the same question a second time (#294, same content as #275).
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '措辞' })
  const prompt = rolePrompt(env.store.get(projectId), workerKey('t_x'))
  assert.match(prompt, /别再转回去请他「汇总回答」/)
  assert.match(prompt, /你只做和你线程有关的那部分/)
  assert.doesNotMatch(rolePrompt(env.store.get(projectId), COORDINATOR), /别再转回去请他「汇总回答」/, '只写给执行者')
})

test('bug 22: a chat line that only @Mira but accepts a thread also reaches the coordinator; a plain @Mira note still does not', async () => {
  // cloud-run-14 #390: 「图片 evidence 这张我收了…@Mira 接入完以后，你那边「没收尾的事」还留着截图 evidence 吗？」 had to: ['mira'],
  // so nobody relayed the acceptance; the thread was still review_ready when the run ended (#395 Mira even said 已归入决定).
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '夹带验收' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '接入图片 evidence', brief: '接', assignee: '工程师' })
  env.actions.updateCard(project, workerKey(threadId), { state: 'review_ready', summary: '13/13 通过' })
  const { messageId } = env.actions.ownerPost({ projectId, text: '图片 evidence 这张我收了，测试也够了。@Mira 接入完以后，你那边「没收尾的事」还留着截图 evidence 吗？' })
  const posted = project.events.find(e => e.type === 'message.posted' && e.messageId === messageId)
  assert.deepEqual(posted.to, [COORDINATOR, MIRA], '验收那半句也到协调员手里')
  assert.equal(posted.miraFirst, true)
  assert.match(renderItem(project, posted), /note="只 @ 了记忆助理，但夹着验收 \/ 收尾/)
  assert.match(rolePrompt(project, COORDINATOR), /夹着验收、收尾、归档之类归你管的事时你也会收到/)
  const note = env.actions.ownerPost({ projectId, text: '@Mira 记一下：以后回复只要结论，不要复述过程。' })
  const plain = project.events.find(e => e.type === 'message.posted' && e.messageId === note.messageId)
  assert.deepEqual(plain.to, [MIRA], '纯 @Mira 的话还是她一个人的')
  assert.equal(plain.miraFirst, undefined)
  assert.doesNotMatch(renderItem(project, plain), /note=/)
})

test('bug 23: 「Mira，…」 at the start of a chat line addresses her, @ or not; a name mid-sentence does not', () => {
  // cloud-run-16 #193/#212: 「Mira，你四栏记忆现在都写的啥？念给我听听」 had to: ['coordinator']; the coordinator chose no_reply twice,
  // and the user got nothing until they retyped the line with @Mira.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '直呼' })
  const project = env.store.get(projectId)
  assert.deepEqual(env.store.mentions(project, 'Mira，你四栏记忆现在都写的啥？念给我听听。'), [MIRA])
  assert.deepEqual(env.store.mentions(project, 'mira: 四栏念一下'), [MIRA])
  assert.deepEqual(env.store.mentions(project, 'Mira你记一下'), [MIRA])
  assert.deepEqual(env.store.mentions(project, '工程师，看一下 hello.md'), ['engineer'])
  assert.deepEqual(env.store.mentions(project, '让 Mira 念一下四栏'), [], '句中提到名字不算点名')
  assert.deepEqual(env.store.mentions(project, '工程师那条线程我验收了'), [], '名字后面没有停顿不算')
  const { messageId } = env.actions.ownerPost({ projectId, text: 'Mira，你四栏记忆现在都写的啥？' })
  const posted = project.events.find(e => e.type === 'message.posted' && e.messageId === messageId)
  assert.deepEqual(posted.to, [MIRA], '直呼 Mira 的话是她一个人的')
  assert.match(rolePrompt(project, COORDINATOR), /喊了记忆助理的名字（她以前叫 Mira，用户说 Mira 也是指她）却没 @ 她/)
})

test('r20: an @Mira note that mentions 作废 stays hers alone; the Mira prompt spells out memory hygiene', () => {
  // cloud-run-17 #335: 「@Mira 记一下：…作废…」 matched the bug-㉒ closing words, the coordinator was woken for nothing and
  // chose no_reply. Same run: Mira listed 7 decisions when 4 were the user's; 3 were remarks, 2 open loops had no source.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '记忆卫生' })
  const project = env.store.get(projectId)
  const { messageId } = env.actions.ownerPost({ projectId, text: '@Mira 记一下：分页那个拍板作废了，按页码来，别再提醒我。' })
  const posted = project.events.find(e => e.type === 'message.posted' && e.messageId === messageId)
  assert.deepEqual(posted.to, [MIRA], '作废 / 停掉 / 取消 不再算收尾请求')
  assert.equal(posted.miraFirst, undefined)
  const { messageId: closing } = env.actions.ownerPost({ projectId, text: '@Mira 记一下：这条我收了，把卡片关掉。' })
  assert.deepEqual(project.events.find(e => e.type === 'message.posted' && e.messageId === closing).to, [COORDINATOR, MIRA], '真正的收尾还是两个人都收到')
  const prompt = rolePrompt(project, MIRA)
  assert.match(prompt, /decisions 只记用户拍过板、明说定下的事/)
  assert.match(prompt, /一条事实只放一栏/)
  assert.match(prompt, /open_loops 里每条都要对得上一条真发生的动态/)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /一条事实只放一栏/)
})

test('r21: acceptance and closing are state, not decisions; the coordinator neither re-lists after Mira nor announces 全收尾 twice', () => {
  // cloud-run-18: decisions held 「hello.md 和 recap 接口都已验收」 from #313 on; #328 re-listed 「只剩卡片流选版」 right after
  // Mira #319 said it; #374 「三条线程到这就全收尾了」 and #385 「三条线程全部完成」 said the same thing twice.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '状态不是决定' })
  const project = env.store.get(projectId)
  const mira = rolePrompt(project, MIRA)
  assert.match(mira, /「X 已验收」「三条线程都关单了」是状态不是决定，不进 decisions/)
  const coordinator = rolePrompt(project, COORDINATOR)
  assert.match(coordinator, /已完成：多半是他刚验收过、你也刚说过在收尾，不再通报，直接 no_reply/)
  assert.match(coordinator, /别提前宣布「到这就全收尾了」/)
  assert.doesNotMatch(mira, /别提前宣布/)
  assert.doesNotMatch(rolePrompt(project, workerKey('t_x')), /是状态不是决定/)
})

test('r22: only the shapes of an acceptance count as one; a closing notice names who just spoke; a dispatch note speaks to the worker', () => {
  // cloud-run-19 #401 「@Mira 都关单了…别重复已经关掉的」 and #416 「@Mira 未收尾里那条…我要点头啥？」 were questions, yet the bare
  // keywords sent them to the coordinator as miraFirst; #331 Mira 「只剩 recap 接口待你验收」 → 5 s later #345 said it again.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '问句不是验收' })
  const project = env.store.get(projectId)
  const post = text => { const { messageId } = env.actions.ownerPost({ projectId, text }); return project.events.find(e => e.type === 'message.posted' && e.messageId === messageId) }
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '出卡片样式', brief: '出', assignee: '设计师' })
  env.actions.updateCard(project, workerKey(threadId), { state: 'review_ready', summary: '三版' })
  assert.deepEqual(post('@Mira 都关单了，你四栏记忆现在还剩啥？照实说，别重复已经关掉的。').to, [MIRA], '#401：提问句不是验收')
  assert.deepEqual(post('@Mira 未收尾里那条「截图等你点头」，我要点头啥？翻一下记的，说原文，别自己补。').to, [MIRA], '#416')
  assert.deepEqual(post('@Mira 记一下：分页那个拍板作废了，按页码来，别再提醒我。').to, [MIRA])
  const accept = post('「出卡片样式」我看了，这张我收了，把卡片关掉。@Mira 记一下：这条验收过了，以后别再提醒我。')
  assert.deepEqual(accept.to, [COORDINATOR, MIRA], '真正的验收还是两人都收到')
  assert.equal(accept.miraFirst, true)
  assert.deepEqual(post('基准测试这事算了，数据短期拿不到，先不做了，归档吧。@Mira 记一下。').to, [COORDINATOR, MIRA])
  assert.deepEqual(post('这版可以了，收了。@Mira 记一下：别再提醒。').to, [COORDINATOR, MIRA])
  env.actions.assistantPost(project, MIRA, '记下了：卡片样式已验收。现在只剩 recap 接口待你验收。')
  env.actions.updateCard(project, workerKey(threadId), { state: 'done', summary: '用户在群聊里验收，协调员转达' })
  const closed = [...project.events].reverse().find(e => e.type === 'thread.updated' && e.patch?.state === 'done')
  assert.match(renderItem(project, closed), /note="记忆助理 \d+ 秒前刚在群聊说过话：「出卡片样式」完成这件事不用再通报，no_reply/)
  const quiet = env.actions.createProject({ name: '没人刚说过话' })
  const q = env.store.get(quiet.projectId)
  const other = env.actions.openThread(q, { title: '建 hello 笔记', brief: '建', assignee: '工程师' })
  env.actions.updateCard(q, workerKey(other.threadId), { state: 'review_ready', summary: '建好了' })
  env.actions.updateCard(q, workerKey(other.threadId), { state: 'done', summary: '关了' })
  const quietClosed = [...q.events].reverse().find(e => e.type === 'thread.updated' && e.patch?.state === 'done')
  assert.doesNotMatch(renderItem(q, quietClosed), /note=/)
  assert.match(rolePrompt(project, COORDINATOR), /别写成「选工程师：…」这种选人批注/)
  assert.match(JSON.stringify(env.tools.find(x => x.definition.name === 'open_thread')), /选人批注/)
  assert.match(rolePrompt(project, MIRA), /拍板类的决定只写用户选中的那个选项标签原文/)
})

test('r23: a dispatch note that opens with the assignee @ is not doubled in chat; delivering and asking in one breath is discouraged', () => {
  // cloud-run-20 #7: note 「@工程师 接口这活是你的：…」 showed as 「@工程师 @工程师 接口这活是你的：…」; R3: the researcher
  // delivered a draft the user wanted to read first and raised a decision at the same time, so the thread sat at 「等你」.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '双 @' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆出回顾数据接口', brief: '拆', assignee: '工程师', note: '@工程师 接口这活是你的：先拆出 recap 数据接口，分页方案别自己定。' })
  const line = project.events.find(e => e.type === 'message.posted' && e.threadId === null && e.text.includes('接口这活是你的'))
  assert.equal(line.text, '@工程师 接口这活是你的：先拆出 recap 数据接口，分页方案别自己定。')
  assert.equal(project.events.find(e => e.type === 'thread.opened' && e.threadId === threadId).note, '接口这活是你的：先拆出 recap 数据接口，分页方案别自己定。')
  const plain = env.actions.openThread(project, { title: '出回顾卡片样式', brief: '出', assignee: '设计师', note: '卡片流这版样式你来出。' })
  assert.equal(project.events.find(e => e.type === 'message.posted' && e.threadId === null && e.text.includes('样式你来出')).text, '@设计师 卡片流这版样式你来出。')
  assert.ok(plain.threadId)
  assert.match(JSON.stringify(env.tools.find(x => x.definition.name === 'open_thread')), /不用再以 @ 谁开头/)
  assert.match(rolePrompt(project, workerKey(threadId)), /交付的同时别发拍板卡/)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /交付的同时别发拍板卡/)
})

test('r24: the same held request again is one row, not two; the dispatch reply does not pre-announce a card; options follow the question', () => {
  // cloud-run-21 #161 / #176: the engineer sent `state: working` twice while the time-format question waited — the thread
  // timeline said 「保持等你」 twice and Mira withdrew a card 「因为线程改回进行中」; #14 told the owner 「等你答分页那张卡」 46 s
  // before any card existed; P3's card asked 「8 还是 12」 and offered 12px / 8px.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '挡两次' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆出回顾数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  const first = env.actions.requestDecision(project, key, { question: '时间字段用 ISO 还是毫秒？', options: [{ label: 'ISO' }, { label: '毫秒' }], recommended: 0 })
  env.actions.updateCard(project, key, { state: 'working', summary: '拍板挂着，先做适配层' })
  env.actions.updateCard(project, key, { state: 'working', summary: '适配层做完了', checklist: [{ text: '适配层', done: true }] })
  const held = () => project.events.filter(e => e.type === 'thread.updated' && e.threadId === threadId && Array.isArray(e.ignored))
  assert.equal(held().length, 2, '两次都留在事件记录里')
  assert.equal(held()[0].repeat, undefined)
  assert.equal(held()[1].repeat, true)
  assert.equal(project.threads.get(threadId).state, 'blocked')
  assert.equal(project.threads.get(threadId).summary, '适配层做完了', '第二次带的摘要和清单照常落下')
  const rows = () => snapshot(env.store, env.driver, projectId).project.threads.find(t => t.id === threadId).timeline.filter(r => r.kind === 'event' && r.held)
  assert.equal(rows().length, 1, '时间线只记一行「保持等你」')
  assert.match(renderItem(project, held()[0]), /执行者想改回「进行中」，但还有没答的拍板，状态保持「等你」/)
  assert.doesNotMatch(renderItem(project, held()[1]), /想改回「进行中」/)
  assert.match(renderItem(project, held()[1]), /kind="card_updated".*更新了摘要/)
  // Delivering instead of working is a different ask; so is the same ask once the question moved on.
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '想交付' })
  assert.equal(held()[2].repeat, undefined)
  assert.equal(rows().length, 2)
  env.actions.answerDecision({ projectId, decisionId: first.decisionId, chosen: 0 })
  assert.equal(project.threads.get(threadId).state, 'working')
  env.actions.requestDecision(project, key, { question: '错误码用 HTTP 还是业务码？', options: [{ label: 'HTTP' }, { label: '业务码' }], recommended: 0 })
  env.actions.updateCard(project, key, { state: 'working', summary: '又挂了一张' })
  assert.equal(held().length, 4)
  assert.equal(held()[3].repeat, undefined, '换了一张拍板，再被挡是新的一行')
  assert.equal(rows().length, 3)
  assert.match(rolePrompt(project, COORDINATOR), /别替执行者预告「等你答 X 那张卡」/)
  assert.match(rolePrompt(project, key), /选项顺序跟问题里念的顺序一致/)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /选项顺序跟问题里念的顺序一致/)
  assert.doesNotMatch(rolePrompt(project, key), /别替执行者预告/)
})

test('r25: 「别把已经关掉的」 is a question, not an acceptance; a delivery card for a working thread is refused; hand-offs across threads are spelled out', () => {
  // cloud-run-22 #397 「@Mira 现在还有什么在等我？一句话，别把已经关掉的再翻出来。」 reached both as miraFirst (把…关掉 matched
  // 「把已经关掉」); #44 Mira's 「接口可验收了」 went up while the thread was still working and was retired 4 s later; #77 the
  // engineer wrote 「这归样式线程」 only in his own thread and nobody carried it over until the user asked at #411.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '别把已经关掉的' })
  const project = env.store.get(projectId)
  const post = text => { const { messageId } = env.actions.ownerPost({ projectId, text }); return project.events.find(e => e.type === 'message.posted' && e.messageId === messageId) }
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆出回顾数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  assert.deepEqual(post('@Mira 现在还有什么在等我？一句话，别把已经关掉的再翻出来。').to, [MIRA], '#397：提问句')
  assert.deepEqual(post('@Mira 把都关了的别再提。').to, [MIRA])
  assert.deepEqual(post('@Mira 别把它关了，我还要看。').to, [MIRA])
  assert.deepEqual(post('「出卡片流样式」我看了，这张我收了，把卡片关掉。@Mira 记一下：这条验收过了，以后别再提醒我。').to, [COORDINATOR, MIRA], '#315：真验收')
  assert.deepEqual(post('把那张关了吧。@Mira 记一下。').to, [COORDINATOR, MIRA])
  const seq = project.events.at(-1).seq
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '接口可验收了', body: '工程师已按你选的页码分页交付。', thread_id: threadId, evidence_seq: [seq] }), /还在「进行中」，没到待验收/)
  const onward = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '按页码继续', body: '工程师按你选的改。', thread_id: threadId, evidence_seq: [seq] })
  assert.equal(project.cards.get(onward.cardId).state, 'open', '不说交付的 next_step 照旧')
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付了' })
  const delivered = project.events.at(-1).seq
  const review = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '验收 recap 接口', body: '交付了。', thread_id: threadId, evidence_seq: [delivered] })
  assert.equal(project.cards.get(review.cardId).state, 'open')
  assert.match(rolePrompt(project, key), /别只在自己线程里写一句「这归他们」/)
  assert.match(rolePrompt(project, COORDINATOR), /执行者用 message_coordinator 说某件事归别的线程/)
  assert.match(rolePrompt(project, MIRA), /递一张 open_loop 卡，写清是谁在哪条线程里说的/)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /递一张 open_loop 卡/)
  assert.doesNotMatch(rolePrompt(project, MIRA), /这归他们/)
  assert.match(JSON.stringify(env.tools.find(x => x.definition.name === 'message_coordinator')), /别转回去请他「汇总回答」/)
})

test('r26: a closed thread stays closed — a worker cannot reopen it, a relay into it is refused, the follow-up is a new thread', async () => {
  // cloud-run-23 #429 「@工程师 evidence 那栏的截图字段这版就加上吧…改完把线程置成待验收」: the coordinator relayed it (#431) into
  // the thread the owner had accepted at #401, the engineer set working (#438) → review_ready (#442) → done (#470) — one
  // thread accepted twice while Mira's memory and the retired cards said it was over. #347 explained 「得 @Mira」 to a user
  // who had; the ownerless 「页码插新卡会重/漏，等用户之后定」 sat in open_loops from #81 to #485 without a card.
  const env = setup(async agent => { await env.call(agent, 'no_reply', {}) })
  const { projectId } = env.actions.createProject({ name: '关了的不重开' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付' })
  env.actions.updateCard(project, key, { state: 'done', summary: '用户在群聊里验收，协调员转达' })
  await settle(env.driver)
  const worker = env.agents.get(project.sessions.get(key).sessionId)
  assert.ok(worker)
  const reply = await env.call(worker, 'update_card', { state: 'working', summary: '加 screenshot 字段' })
  assert.match(reply, /^状态没改：这条线程已经关单（用户验收过、完成了），关了的线程不重开，仍是「完成」。其余已更新：summary。.*message_coordinator 请协调员新开一条线程/)
  assert.equal(project.threads.get(threadId).state, 'done', '关了的线程不重开')
  assert.equal(project.threads.get(threadId).summary, '加 screenshot 字段', '摘要照常落下')
  const held = () => project.events.filter(e => e.type === 'thread.updated' && e.threadId === threadId && Array.isArray(e.ignored))
  assert.equal(held().length, 1)
  assert.deepEqual([held()[0].wanted, held()[0].closed, held()[0].repeat], ['working', true, undefined])
  assert.match(renderItem(project, held()[0]), /执行者想把已关单的线程改为「进行中」，关了的线程不重开，状态保持「完成」/)
  const rows = () => snapshot(env.store, env.driver, projectId).project.threads.find(t => t.id === threadId).timeline.filter(r => r.kind === 'event' && r.held)
  assert.equal(rows().length, 1)
  assert.match(JSON.stringify(rows()[0]), /想把已关单的线程改为「进行中」，关了的线程不重开/)
  // Trying again is a repeat: on the record, not in the timeline; delivering is held the same way.
  env.actions.updateCard(project, key, { state: 'working', summary: '再试' })
  assert.equal(held()[1].repeat, true)
  assert.equal(rows().length, 1)
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '想交付' })
  assert.equal(project.threads.get(threadId).state, 'done')
  assert.equal(held()[2].closed, true)
  // The coordinator cannot relay into it either; the error says where the follow-up goes.
  assert.throws(() => env.actions.relay(project, COORDINATOR, { toKey: key, text: '用户要加 screenshot 字段，改完置回待验收。' }), /线程「拆 recap 数据接口」已经完成（用户验收过），关了的线程不重开，这条话没转。.*open_thread 新开一条给同一负责人/)
  assert.equal(project.events.filter(e => e.type === 'relay.sent').length, 0)
  // Archived is closed the same way; failed is not — a retry goes back to work.
  const { threadId: archived } = env.actions.openThread(project, { title: '出卡片流样式', brief: '样', assignee: '设计师' })
  env.actions.updateCard(project, workerKey(archived), { state: 'working', summary: '开工' })
  env.actions.ownerUpdateThread({ projectId, threadId: archived, resolved: true })
  env.actions.updateCard(project, workerKey(archived), { state: 'review_ready', summary: '交付' })
  assert.equal(project.threads.get(archived).state, 'working')
  assert.equal(project.events.at(-1).closed, true)
  assert.throws(() => env.actions.relay(project, COORDINATOR, { toKey: workerKey(archived), text: '补一版' }), /「出卡片流样式」已归档，关了的线程不重开/)
  const { threadId: failed } = env.actions.openThread(project, { title: '新建 notes/hello.md', brief: '建', assignee: '工程师' })
  env.actions.updateCard(project, workerKey(failed), { state: 'failed', summary: '目录不存在' })
  env.actions.updateCard(project, workerKey(failed), { state: 'working', summary: '目录建好了，重试' })
  assert.equal(project.threads.get(failed).state, 'working', 'failed 不算关单')
  assert.doesNotThrow(() => env.actions.relay(project, COORDINATOR, { toKey: workerKey(failed), text: '用户说目录建好了' }))
  // The protocols say so, each to its own reader.
  assert.match(rolePrompt(project, COORDINATOR), /关了的线程不重开，message_thread 发不进去、执行者也改不了状态/)
  assert.match(rolePrompt(project, COORDINATOR), /别再说「这归记忆助理、得 @记忆助理」/)
  assert.match(rolePrompt(project, MIRA), /没有拍板卡挂着就不算在等用户答/)
  assert.match(rolePrompt(project, key), /done 之后这条线程就关了/)
  assert.doesNotMatch(rolePrompt(project, MIRA), /关了的线程不重开/)
  assert.doesNotMatch(rolePrompt(project, key), /得 @记忆助理/)
  assert.match(JSON.stringify(env.tools.find(x => x.definition.name === 'message_thread')), /已完成、已归档的线程发不进去/)
})

test('r27: a card never shows the owner a seq; loops the owner deferred himself are his call; the coordinator stops at 「没了」', () => {
  // cloud-run-24 #146 / #297: Mira's cards read 「序号（seq）60 卡片流样式…」; #356 she recited the error-code question the owner
  // had set aside (#232 「先不选了」) as 「你还没定」 and never carded it, while cloud-run-23's ownerless 「等用户之后定」 (an
  // engineer's line, never put to the owner) went uncarded too; #452 the coordinator answered 「没了」 and offered more work.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '别给用户看 seq' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '先开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付' })
  const seq = project.events.at(-1).seq
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '三件等你验收', body: '序号（seq）60 卡片流样式、notes/hello.md 也都等你验收。', thread_id: threadId, evidence_seq: [seq] }), /别写 seq/)
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: 'seq 60 待验收', body: '看一眼。', thread_id: threadId, evidence_seq: [seq] }), /别写 seq/)
  assert.equal(project.cardOrder.length, 0, '被拒的卡没落下')
  const fine = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '接口待验收', body: '工程师交付时写的：页码分页、6/6 测试过。打开线程验收。', thread_id: threadId, evidence_seq: [seq] })
  assert.equal(project.cards.get(fine.cardId).state, 'open')
  assert.match(rolePrompt(project, MIRA), /没有拍板卡挂着就不算在等用户答，这件事是执行者说的、不是用户定的/)
  assert.match(rolePrompt(project, MIRA), /用户自己说「先不选」「下一版再」的不在此列.*别写成「你还没定」/)
  assert.match(rolePrompt(project, MIRA), /别报 seq 号/)
  assert.match(rolePrompt(project, COORDINATOR), /没有在等他的就说没有，别顺手提议「我可以让工程师…」/)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /别报 seq 号/)
  assert.doesNotMatch(rolePrompt(project, key), /用户自己说「先不选」/)
  // #54: a card citing the question's chat mirror after the owner answered is the same stale card as one citing the decision.
  env.actions.updateCard(project, key, { state: 'working', summary: '返工' })
  const { decisionId } = env.actions.requestDecision(project, key, { question: 'recap 卡片流分页用哪种？', options: [{ label: '游标分页' }, { label: '页码分页' }], recommended: 0 })
  const mirrors = project.events.filter(e => e.type === 'message.posted' && e.card?.kind === 'decision' && e.card.decisionId === decisionId).map(e => e.seq)
  assert.equal(mirrors.length, 2, '线程里一条、群聊里一条镜像')
  env.actions.answerDecision({ projectId, decisionId, chosen: 1 })
  for (const cite of mirrors) {
    assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '选recap分页方式', body: '差你选一种才能收尾。', thread_id: threadId, evidence_seq: [seq, cite] }), /用户已经选了「页码分页」/)
  }
  assert.equal(project.cardOrder.length, 1, '镜像引用的过时卡也没落下')
})

test('r28: a done thread\'s loose end may become an open_loop card whose 「回一句」 goes to the chat; next_step and archived stay refused; the executor lets go of only the named decision', () => {
  // cloud-run-25 #354: 「不用递：线程「拆recap数据接口」已经完成，关于它的 open_loop 卡会立刻过时」 — the engineer had written
  // 「错误码格式等用户之后定」, never put it to the owner, and delivered; the thread was accepted; nobody held the loose end.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '关单线程的尾巴' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付；错误码格式等用户之后定' })
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done' })
  const seq = project.events.at(-1).seq
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '错误码格式待定', body: '工程师交付时写了等你定。', thread_id: threadId, evidence_seq: [seq] }), /已经完成，关于它的 next_step 卡会立刻过时；它留下的尾巴.*用 open_loop 递/)
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '错误码格式待定', body: '工程师交付时写了等你定。', thread_id: threadId, evidence_seq: [seq] }), /已经完成，关于它的 reminder 卡会立刻过时。$/)
  const { cardId } = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '接口留了个尾巴', body: '工程师在「拆 recap 数据接口」里写了错误码格式等你定，没发拍板；线程已关单。', thread_id: threadId, evidence_seq: [seq], actions: [{ id: 'reply', text: '@协调员 新开一条给工程师：定 recap 接口的错误码格式' }] })
  const card = project.cards.get(cardId)
  assert.equal(card.state, 'open')
  assert.deepEqual(card.actions.map(a => a.id), ['open_thread', 'reply'])
  const shown = snapshot(env.store, env.driver, projectId).project.cards.find(c => c.id === cardId)
  assert.equal(shown.threadClosed, true, '关单线程上的卡：回一句填进群聊')
  // Archiving is the owner closing the book: the card goes with it, and nothing more may be hung on the thread.
  env.actions.ownerUpdateThread({ projectId, threadId, resolved: true })
  assert.equal(project.cards.get(cardId).state, 'stale')
  assert.equal(project.cards.get(cardId).closedNote, '线程已归档')
  assert.throws(() => env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '接口留了个尾巴', body: '同上。', thread_id: threadId, evidence_seq: [seq] }), /已经归档/)
  // A card on a live thread is unchanged.
  const live = env.actions.openThread(project, { title: '出卡片流样式', brief: '样式', assignee: '设计师' })
  const liveCard = env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '样式还没人接', body: '设计师线程开了还没动。', thread_id: live.threadId, evidence_seq: [project.events.at(-1).seq] })
  assert.equal(snapshot(env.store, env.driver, projectId).project.cards.find(c => c.id === liveCard.cardId).threadClosed, false)
  assert.match(rolePrompt(project, MIRA), /已完成的线程不再递 next_step \/ reminder.*只有 open_loop 还能递.*@协调员 新开一条给工程师/)
  assert.match(rolePrompt(project, workerKey(live.threadId)), /只放掉他点名的那张.*另外那张「X」也按推荐项「Y」选吗/)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /只放掉他点名的那张/)
  assert.match(JSON.stringify(env.tools.find(x => x.definition.name === 'card_propose')), /已完成的线程留下的尾巴用 open_loop/)
})

test('r29: the coordinator keeps thread ids out of the chat; a card Mira withdraws keeps her reason', () => {
  // cloud-run-26 #15 「开两条线程了：- 工程师：拆 recap 数据接口（t_efa81de251）…」 and #321: the card she withdrew showed
  // 「已撤（withdrawn）」 to the director, its reason gone.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '群聊里没有 id' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  const posted = () => project.events.filter(e => e.type === 'message.posted' && e.author.kind === 'assistant').length
  const before = posted() // the thread's own 派单语 line is already there
  assert.throws(() => env.actions.assistantPost(project, COORDINATOR, `开了两条：拆 recap 数据接口 → @工程师（${threadId}）。`), /群聊里别写线程 id/)
  assert.throws(() => env.actions.assistantPost(project, COORDINATOR, '新开了一条给工程师（t_7ba35d1d74），旧的那条没动。'), /群聊里别写线程 id/)
  assert.equal(posted(), before, '被拒的话没发出去')
  env.actions.assistantPost(project, COORDINATOR, '开了两条：拆 recap 数据接口 → @工程师；卡片流样式 → @设计师。')
  // A thread message may still name an id: it is the worker talking to the owner about the record, not the chat.
  env.actions.assistantPost(project, key, `这条是 ${threadId} 的后续，旧线程不动。`)
  assert.equal(posted(), before + 2)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付' })
  const seq = project.events.at(-1).seq
  const mine = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '接口待验收', body: '工程师交付了，打开线程验收。', thread_id: threadId, evidence_seq: [seq] })
  env.actions.withdrawCard(project, MIRA, mine.cardId, '用户已验收卡片样式，不用再提醒')
  assert.equal(project.cards.get(mine.cardId).state, 'withdrawn')
  assert.equal(project.cards.get(mine.cardId).closedNote, '用户已验收卡片样式，不用再提醒')
  assert.equal(snapshot(env.store, env.driver, projectId).project.cards.find(c => c.id === mine.cardId).closedNote, '用户已验收卡片样式，不用再提醒')
  const host = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '接口待验收', body: '工程师交付了，打开线程验收。', thread_id: threadId, evidence_seq: [seq] })
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done' })
  assert.equal(project.cards.get(host.cardId).state, 'stale')
  assert.equal(project.cards.get(host.cardId).closedNote, '线程已验收')
  assert.match(rolePrompt(project, COORDINATOR), /别写 t_ 开头的线程 id/)
  assert.doesNotMatch(rolePrompt(project, MIRA), /别写 t_ 开头的线程 id/)
})

test('a task is named as a link the owner can click; only its address carries the id (2026-11-18)', () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '任务链接' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  const { threadId } = env.actions.openThread(project, { title: '梳理群成员在做什么', brief: '梳理', assignee: '工程师' })
  env.actions.assistantPost(project, COORDINATOR, `[梳理群成员在做什么](https://task.local/${threadId}) 交了：人员依赖和 5 个议题，等你看一眼。`)
  assert.throws(() => env.actions.assistantPost(project, COORDINATOR, `[${threadId}](https://task.local/${threadId}) 交了`), /群聊里别写线程 id/, 'the id as the visible words is still refused')
  assert.throws(() => env.actions.assistantPost(project, COORDINATOR, `[梳理](https://task.local/${threadId}) 交了（${threadId}）`), /群聊里别写线程 id/)
  const prompt = rolePrompt(project, COORDINATOR)
  assert.match(prompt, /写成 \[任务标题\]\(https:\/\/task\.local\/线程id\)/)
  assert.match(prompt, /告诉他时一定带上那个任务的链接/)
  assert.match(prompt, /开任务不用先问他/)
  assert.match(prompt, /对他来说只有一个助理/)
  assert.match(prompt, /任务标题：他以后只凭标题/)
  assert.match(prompt, /他的每句话都要有回应，用最小的那种/)
})

test('r30: Mira cannot relay; a loose end whose thread was accepted is named on her memory_write; 「先不做了」 without a thread stays hers', () => {
  // cloud-run-27 #276: Mira message_coordinator'd the owner's chat question (stamped from_thread="ra"); #412: she wrote the
  // engineer's unput choice into open_loops after the thread closed and said nothing; #536: 「@Mira …先不做了…把那条清掉」 woke the coordinator.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '关单的尾巴' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  const { threadId } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  const key = workerKey(threadId)
  const relays = () => project.events.filter(e => e.type === 'relay.sent').length
  assert.throws(() => env.actions.relay(project, MIRA, { toKey: COORDINATOR, text: '用户在群聊里问还有哪几件事在等他。' }), /记忆助理不转话/)
  assert.equal(relays(), 0)
  env.actions.relay(project, key, { toKey: COORDINATOR, text: '需要样式线程的字段名。' })
  assert.equal(relays(), 1)
  assert.equal(project.events.at(-1).fromThreadId, threadId)
  env.actions.assistantPost(project, key, '翻页插新卡有三个取舍：前端去重 / 水位线过滤 / 切回游标，等你之后定。')
  const said = project.events.at(-1).seq
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '交付' })
  env.actions.ownerUpdateThread({ projectId, threadId, state: 'done' })
  const live = env.actions.openThread(project, { title: '出回顾卡片样式', brief: '样式', assignee: '设计师' })
  env.actions.assistantPost(project, workerKey(live.threadId), '圆角大小等你定。')
  const liveSeq = project.events.at(-1).seq
  const written = env.actions.writeMemory(project, MIRA, {
    open_loops: [
      { text: '翻页插卡三选一取舍待定，接口线程已关', evidence_seq: [said] },
      { text: '错误码你说先不选了，先放着以后再说', evidence_seq: [said] },
      { text: '圆角大小待定', evidence_seq: [liveSeq] },
    ],
  })
  assert.match(written, /^now 0，decisions 0，openLoops 3，facts 0。提醒：「翻页插卡三选一取舍待定，接口线程已关」的依据在已关单的线程「拆 recap 数据接口」里/)
  assert.match(written, /递一张 open_loop 卡（thread_id 挂这条线程，动作带 reply/)
  assert.doesNotMatch(written, /错误码/, '用户自己说先不选的不算')
  assert.doesNotMatch(written, /圆角/, '线程还开着的不算')
  assert.equal((written.match(/提醒/g) ?? []).length, 1)
  env.actions.proposeCard(project, MIRA, { kind: 'open_loop', title: '翻页取舍没定', body: '工程师在接口线程里留了三个取舍没定，线程已关单。', thread_id: threadId, evidence_seq: [said], actions: [{ id: 'reply', text: '@协调员 新开一条给工程师：定翻页插卡的取舍' }] })
  const again = env.actions.writeMemory(project, MIRA, { open_loops: [{ text: '翻页插卡三选一取舍待定，接口线程已关', evidence_seq: [said] }] })
  assert.equal(again, 'now 0，decisions 0，openLoops 1，facts 0', '卡递了就不再提醒')
  // 「先不做了」 about a memory row is Mira's alone; naming a thread (title or 「线程」) or 「归档吧」 brings the coordinator in.
  const post = text => { const { messageId } = env.actions.ownerPost({ projectId, text }); return project.events.find(e => e.type === 'message.posted' && e.messageId === messageId) }
  const dropped = post('@Mira 翻页插卡那三个取舍先不做了，翻页就按现在这样，别再盯着了，把那条清掉。')
  assert.deepEqual(dropped.to, [MIRA])
  assert.equal(dropped.miraFirst, undefined)
  assert.equal(post('@Mira 出回顾卡片样式先不做了，记一下。').miraFirst, true)
  assert.equal(post('@Mira 那条线程算了，不做了。').miraFirst, true)
  assert.equal(post('@Mira 基准测试这事算了，归档吧。').miraFirst, true)
  assert.equal(post('@Mira 接口这张我收了，把卡片关掉。').miraFirst, true)
  assert.match(rolePrompt(project, MIRA), /不给协调员转话/)
  assert.match(rolePrompt(project, MIRA), /同一轮里就递，别只记不递/)
  assert.match(env.tools.find(x => x.definition.name === 'memory_write').definition.description, /照它说的递 open_loop 卡/)
})

test('r30: once the owner @\'d Mira, the coordinator cannot answer with 「这归 Mira、她已被点名」; 「得 @Mira」 for a line without @ still can', () => {
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '归 Mira' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  const posted = () => project.events.filter(e => e.type === 'message.posted' && e.author.kind === 'assistant').length
  env.actions.ownerPost({ projectId, text: '@Mira 拆 recap 数据接口先不做了，别再盯着了，把那条清掉。' })
  assert.equal(project.events.at(-1).miraFirst, true)
  const before = posted()
  assert.throws(() => env.actions.assistantPost(project, COORDINATOR, '这件事归 Mira 记，她已被点名。相关线程都关了，没有别的要处理。'), /用户已经 @记忆助理了/)
  assert.throws(() => env.actions.assistantPost(project, COORDINATOR, '记忆的部分得 @Mira，她会答。'), /用户已经 @记忆助理了/)
  assert.equal(posted(), before, '被拒的话没发出去')
  env.actions.assistantPost(project, COORDINATOR, '「拆 recap 数据接口」不做了的话，在它的卡上点「归档」就行，助理归档不了。')
  assert.equal(posted(), before + 1)
  env.actions.ownerPost({ projectId, text: '让 Mira 念一下记忆。' })
  env.actions.assistantPost(project, COORDINATOR, '要 Mira 答得 @Mira，她没被点名看不到。')
  assert.equal(posted(), before + 2)
  assert.match(rolePrompt(project, COORDINATOR), /平台会拒这句：这条消息里没有归你管的就 no_reply/)
})

test('r31: a decision asked after delivery pulls the thread back to 「等你」, retires Mira\'s 「待验收」 card and tells the worker to fix the summary; memory.updated records the loose-end reminder', () => {
  // cloud-run-28 R6 → R8: 「healthz 待验收」 (#504) stayed open after two decisions (#511, #515) pulled the thread back to blocked,
  // and the summary kept saying 待验收; #531 「你答了我就作废它」 mixed answering with withdrawing.
  const env = setup(async () => {})
  const { projectId } = env.actions.createProject({ name: '交付后又拍板' })
  const project = env.store.get(projectId)
  env.actions.ownerPost({ projectId, text: '开工' })
  const { threadId } = env.actions.openThread(project, { title: '加 /healthz 接口', brief: '加', assignee: '工程师' })
  const key = workerKey(threadId)
  env.actions.updateCard(project, key, { state: 'working', summary: '开工' })
  env.actions.updateCard(project, key, { state: 'review_ready', summary: '/healthz 已加上，待验收' })
  const delivered = project.events.at(-1).seq
  const review = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: 'healthz 待验收', body: '/healthz 已加上，原三个接口仍 200。', thread_id: threadId, evidence_seq: [delivered] })
  const remind = env.actions.proposeCard(project, MIRA, { kind: 'reminder', title: '截图下一版再加', body: '你说 evidence 的截图下一版再加。', thread_id: threadId, evidence_seq: [delivered] })
  const asked = env.actions.requestDecision(project, key, { question: '/healthz 要不要写进 SMOKE.md？', options: [{ label: '写进 SMOKE.md' }, { label: '不写' }], recommended: 0 })
  assert.equal(asked.wasReview, true)
  assert.match(asked.hint, /线程从「待验收」回到了「等你」.*update_card 把它改成「在等你选 X；交付的东西原样放着」/)
  assert.equal(project.threads.get(threadId).state, 'blocked')
  assert.equal(project.cards.get(review.cardId).state, 'stale')
  assert.equal(project.cards.get(review.cardId).closedNote, '线程回到「等你」：执行者又发了拍板')
  assert.equal(project.cards.get(remind.cardId).state, 'open', '提醒卡不是关于交付的，留着')
  const again = env.actions.requestDecision(project, key, { question: '返回里要不要加 uptime_seconds？', options: [{ label: '加 uptime_seconds' }, { label: '不加' }], recommended: 0 })
  assert.equal(again.wasReview, false)
  assert.equal(again.hint, '')
  assert.deepEqual(again.pending, [asked.decisionId])
  assert.equal(project.cards.get(remind.cardId).state, 'open')
  // A question asked while still working touches no card.
  const { threadId: live } = env.actions.openThread(project, { title: '出 recap 卡片样式', brief: '出', assignee: '设计师' })
  env.actions.updateCard(project, workerKey(live), { state: 'working', summary: '开工' })
  const working = project.events.at(-1).seq
  const early = env.actions.proposeCard(project, MIRA, { kind: 'next_step', title: '样式等你看一眼', body: '设计师开工了。', thread_id: live, evidence_seq: [working] })
  const fresh = env.actions.requestDecision(project, workerKey(live), { question: '卡片圆角用 8 还是 12？', options: [{ label: '8' }, { label: '12' }], recommended: 1 })
  assert.equal(fresh.wasReview, false)
  assert.equal(project.cards.get(early.cardId).state, 'open')
  // memory.updated says when the loose-end reminder fired.
  const { threadId: closed } = env.actions.openThread(project, { title: '拆 recap 数据接口', brief: '拆', assignee: '工程师' })
  env.actions.assistantPost(project, workerKey(closed), '翻页插卡有三个取舍等你定。')
  const said = project.events.at(-1).seq
  env.actions.updateCard(project, workerKey(closed), { state: 'review_ready', summary: '交付' })
  env.actions.ownerUpdateThread({ projectId, threadId: closed, state: 'done' })
  env.actions.writeMemory(project, MIRA, { open_loops: [{ text: '翻页插卡取舍待定，接口线程已关', evidence_seq: [said] }] })
  const hinted = project.events.at(-1)
  assert.equal(hinted.type, 'memory.updated')
  assert.equal(hinted.hinted, 1)
  env.actions.writeMemory(project, MIRA, { open_loops: [] })
  assert.equal(project.events.at(-1).hinted, undefined)
  const prompt = rolePrompt(project, key)
  assert.match(prompt, /交付之后用户又要你发拍板：request_decision 会把线程从「待验收」拉回「等你」/)
  assert.match(prompt, /他说「按推荐的」就是答了.*答了的不叫作废/)
  assert.match(prompt, /放掉的那张按现状交付、话说成「现状不变：…」，别说「按 X 处理」/)
})
