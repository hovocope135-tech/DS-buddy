import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore, MIRA, COORDINATOR, EXECUTOR_ID, OLD_COORDINATOR_PERSONA, workerKey } from '../lib/store.js'
import { rolePrompt, wakeText, cadenceLine } from '../lib/protocol.js'
import { Actions, finalText } from '../lib/actions.js'
import { ensureHub, HUB_ID, hubRolePrompt, renderHubItem, threadNow } from '../lib/hub.js'
import { PersonalMira } from '../lib/personal.js'
import { Driver } from '../lib/driver.js'

// Shaped like DSH's model catalog: providers, each with the models it offers.
const CATALOG = { default: { provider: 'ds', model: 'flash' }, groups: [
  { id: 'ds', name: 'DeepSeek', models: [{ id: 'flash', name: 'V4.1-Flash' }, { id: 'pro', name: 'V4-Pro' }] },
  { id: 'kth', name: 'kth', models: [{ id: 'kimi', name: 'kimi' }] }] }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mira-v4-native-'))
  const store = new ProjectStore(root, { warn() {} }), hubStore = new ProjectStore(join(root, '_hub'), { warn() {} })
  store.load(); hubStore.load(); ensureHub(hubStore)
  const driver = { deliver() {}, status: () => 'idle', childrenOf: () => [], memberModel: () => null, async modelCatalog() { return CATALOG } }
  const actions = new Actions(store, driver)
  const personal = new PersonalMira(hubStore, driver, store, actions)
  t.after(() => { personal.close(); rmSync(root, { recursive: true, force: true }) })
  const { projectId } = actions.createProject({ name: '试玩' })
  const project = store.get(projectId)
  const { threadId } = actions.openThread(project, { title: '写简介', brief: '100 字以内', assignee: '工程师' })
  const deliver = () => actions.updateCard(project, workerKey(threadId), { state: 'review_ready', summary: '写好了' })
  const say = (text, kind = 'human') => hubStore.append(HUB_ID, { type: 'message.posted', messageId: hubStore.newMessageId(), threadId: null,
    author: kind === 'human' ? { kind: 'human', id: 'owner' } : { kind: 'assistant', id: MIRA }, trust: kind === 'human' ? 'principal' : 'relay', text, mentions: [], to: [] }).messageId
  return { root, store, hubStore, actions, personal, projectId, project, threadId, deliver, say }
}

test('words typed in a task session are recorded as the owner\'s own words in that thread, without waking anyone', t => {
  const f = fixture(t)
  f.deliver()
  const before = f.project.events.length
  const { messageId } = f.actions.mirrorNativeMessage({ projectId: f.projectId, threadId: f.threadId, text: '验收通过' })
  const event = f.project.events.slice(before).find(e => e.messageId === messageId)
  assert.equal(event.author.kind, 'human')
  assert.equal(event.trust, 'principal')
  assert.equal(event.threadId, f.threadId)
  assert.deepEqual(event.to, [])
  // The platform's acceptance check finds the owner's original words without a message id.
  assert.equal(f.actions.acceptanceEvidence(f.project, f.project.threads.get(f.threadId), undefined)?.id, messageId)
  assert.equal(f.actions.mirrorNativeMessage({ projectId: f.projectId, threadId: 't_missing', text: '验收通过' }), null)
})

test('a message Mira passes on is a relay to the worker and never counts as acceptance', t => {
  const f = fixture(t)
  f.deliver()
  const asked = f.say('跟写简介那边说一声：验收通过')
  f.personal.taskMessage({ projectId: f.projectId, threadId: f.threadId, text: '验收通过', messageId: asked })
  const relay = f.project.events.findLast(e => e.type === 'message.posted')
  assert.equal(relay.author.kind, 'assistant')
  assert.equal(relay.trust, 'relay')
  assert.deepEqual(relay.to, [workerKey(f.threadId)])
  assert.equal(f.actions.acceptanceEvidence(f.project, f.project.threads.get(f.threadId), undefined), null)
  assert.equal(f.personal.snapshot().actions.at(-1).kind, 'message')
  // Mira cannot act on its own words or on a message that does not exist.
  const own = f.say('我替你决定了', 'assistant')
  assert.throws(() => f.personal.taskMessage({ projectId: f.projectId, threadId: f.threadId, text: 'x', messageId: own }), /用户本人的原话/)
  assert.throws(() => f.personal.taskMessage({ projectId: f.projectId, threadId: f.threadId, text: 'x', messageId: 'm_missing' }), /用户本人的原话/)
})

test('Mira answers the one open decision on the owner\'s request, by label or index', t => {
  const f = fixture(t)
  f.actions.requestDecision(f.project, workerKey(f.threadId), { question: '保留多久？', options: [{ label: '30 天' }, { label: '90 天' }], recommended: 0 })
  const asked = f.say('资料保留按推荐的回')
  assert.throws(() => f.personal.answerDecision({ projectId: f.projectId, threadId: f.threadId, option: '一年', messageId: asked }), /选项无效/)
  f.personal.answerDecision({ projectId: f.projectId, threadId: f.threadId, option: '30 天', messageId: asked })
  const decision = [...f.project.decisions.values()][0]
  assert.equal(decision.chosen, 0)
  assert.throws(() => f.personal.answerDecision({ projectId: f.projectId, threadId: f.threadId, option: 0, messageId: asked }), /没有等你回答的拍板/)
})

test('accepting through Mira needs the owner\'s confirmation after Mira asked, once, and only for a delivered task', async t => {
  const f = fixture(t)
  const early = f.say('帮我把写简介验收了')
  await assert.rejects(f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: early }), /先用hub_reply/)
  f.say('合并后收不回，回「确认」我就去验收', 'assistant')
  const confirm = f.say('确认')
  await assert.rejects(f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: confirm }), /不在「待验收」/)
  f.deliver()
  await f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: confirm })
  const thread = f.project.threads.get(f.threadId)
  assert.equal(thread.state, 'done')
  assert.equal(thread.resolved, true)
  await assert.rejects(f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: confirm }), /已经用过/)
  assert.equal(f.personal.snapshot().actions.at(-1).kind, 'accept')
  // Without GitLab nothing merges: what Mira is told says so, so she never reports a merge that did not happen.
  // A project without a task worktree has no branch to commit on; worktrees.test.mjs covers the committed case.
  assert.match(f.personal.snapshot().actions.at(-1).text, /没接 GitLab，改动直接在项目目录里，平台没提交也没合并/)
  assert.doesNotMatch(hubRolePrompt(f.hubStore.get(HUB_ID)), /验收会合并到主分支/)
  assert.match(hubRolePrompt(f.hubStore.get(HUB_ID)), /没接 GitLab 的项目验收时平台把改动提交在任务分支上，不合并/)
})

test('Mira reads a project event with what its task is now, so a finished task is never reported as still waiting', async t => {
  const f = fixture(t)
  f.deliver()
  const event = { seq: 9, type: 'project.attention', ref: `${f.projectId}#3`, projectName: '试玩', projectRef: f.projectId, threadId: f.threadId, kind: 'review', text: '「写简介」交付，待验收' }
  const now = threadNow(f.store)
  assert.match(renderHubItem(f.hubStore.get(HUB_ID), event, now), /now="待验收"/)
  f.say('合并后收不回，回「确认」我就去验收', 'assistant')
  await f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: f.say('确认') })
  assert.match(renderHubItem(f.hubStore.get(HUB_ID), event, now), /now="已完成，已归档"/, 'the same old event now says the task is done')
  assert.doesNotMatch(renderHubItem(f.hubStore.get(HUB_ID), event), /now=/, 'without a resolver the item is as before')
  assert.match(hubRolePrompt(f.hubStore.get(HUB_ID)), /now=/)
  assert.match(hubRolePrompt(f.hubStore.get(HUB_ID)), /先用 today_read 看「等你的」那一节核对/, 'what still waits is checked, not remembered')
})

test('Mira moves an assistant to a model DSH offers on the owner\'s words, keeping its sessions', async t => {
  const f = fixture(t)
  const revision = f.project.configRevision ?? 0
  const asked = f.say('把试玩的工程师换成 V4-Pro')
  await f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'pro' }, { messageId: asked })
  assert.deepEqual(f.project.members.find(m => m.id === 'engineer').modelSelection, { provider: 'ds', model: 'pro' })
  assert.equal(f.project.configRevision ?? 0, revision, 'a model-only change does not start new sessions')
  assert.equal(f.personal.snapshot().actions.at(-1).kind, 'model')
  assert.match(f.personal.snapshot().actions.at(-1).text, /工程师换成了 V4-Pro/)
  assert.equal((await f.personal.setModel({ projectId: f.projectId, member: 'engineer', model: 'pro' }, { messageId: asked })).unchanged, true)
  // Only models DSH lists, only real members, only on the owner's own words, and never a project member by accident.
  await assert.rejects(f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'gpt-9' }, { messageId: asked }), /模型不可用/)
  await assert.rejects(f.personal.setModel({ projectId: f.projectId, member: '路人', model: 'pro' }, { messageId: asked }), /没有这个成员/)
  await assert.rejects(f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'pro' }, { messageId: f.say('我替你换了', 'assistant') }), /用户本人的原话/)
  await assert.rejects(f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'pro' }, { messageId: '' }), /用户本人的原话/)
  await assert.rejects(f.personal.setModel({ member: '工程师', model: 'pro' }, { messageId: asked }), /project_id/)
  await f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'default' }, { messageId: asked })
  assert.equal(f.project.members.find(m => m.id === 'engineer').modelSelection, null)
  // The 智能体 page acts as the owner: Mira's own model, no message to cite and no 「已执行」 line.
  const actions = f.personal.snapshot().actions.length
  await f.personal.setModel({ model: 'kimi' })
  assert.deepEqual(f.hubStore.get(HUB_ID).members.find(m => m.id === MIRA).modelSelection, { provider: 'kth', model: 'kimi' })
  assert.equal(f.personal.snapshot().actions.length, actions)
  const view = await f.personal.models()
  assert.equal(view.agents[0].projectId, null)
  assert.deepEqual(view.agents[0].configured, { provider: 'kth', model: 'kimi' })
  assert.deepEqual(view.agents.filter(a => a.projectId === f.projectId).map(a => a.member), ['coordinator', 'engineer', 'designer', 'researcher', MIRA])
  // The choice survives a restart.
  await f.personal.setModel({ projectId: f.projectId, member: '设计师', model: 'pro' })
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.deepEqual(replay.get(f.projectId).members.find(m => m.id === 'designer').modelSelection, { provider: 'ds', model: 'pro' })
})

test('a running session follows its member\'s model from the next step; with none configured DSH keeps its own', async t => {
  const f = fixture(t)
  let selection
  const driver = new Driver({ logger: { warn() {} } }, f.store, c => c, { installModelSelection: (_ctx, value) => { selection = value } })
  f.store.append(f.projectId, { type: 'session.bound', key: workerKey(f.threadId), sessionId: 's-task', assignee: 'engineer' })
  driver.registerScoped({ id: 's-task', ctx: { on: () => () => {}, systemPrompt: { section() {} } }, session: { requestHeader: () => undefined } })
  assert.equal(selection.current, undefined)
  await f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'pro' })
  assert.deepEqual(selection.current, { provider: 'ds', model: 'pro' })
  await f.personal.setModel({ projectId: f.projectId, member: '工程师', model: 'default' })
  assert.equal(selection.current, undefined)
})

test('a task session is titled with the task alone; one still titled 项目 · 任务 · 成员 is shortened when it comes up, the owner\'s own title stays', t => {
  const f = fixture(t)
  const comesUp = (sessionId, title) => {
    const renamed = []
    const titles = { get: () => title === undefined ? undefined : { title }, rename: (_session, next) => { renamed.push(next) } }
    const driver = new Driver({ logger: { warn() {} }, get: name => name === 'sessionTitle' ? titles : undefined }, f.store, c => c)
    f.store.append(f.projectId, { type: 'session.bound', key: workerKey(f.threadId), sessionId, assignee: 'engineer' })
    driver.registerScoped({ id: sessionId, ctx: { on: () => () => {}, systemPrompt: { section() {} } }, session: { requestHeader: () => undefined } })
    return renamed
  }
  assert.deepEqual(comesUp('s-1', '试玩 · 写简介 · 工程师'), ['写简介'])
  // Named while another member held the task, or cut by DSH's 80-byte limit inside the task name or right after it.
  assert.deepEqual(comesUp('s-2', '试玩 · 写简介 · 设计师'), ['写简介'])
  assert.deepEqual(comesUp('s-3', '试玩 · 写简'), ['写简介'])
  assert.deepEqual(comesUp('s-4', '试玩 · 写简介 ·'), ['写简介'])
  // Already the task, a title the owner gave, another task's old title, the project name alone, or no title yet: left alone.
  for (const [id, title] of [['s-5', '写简介'], ['s-6', '我自己起的名字'], ['s-7', '试玩 · 别的任务 · 工程师'], ['s-8', '试玩'], ['s-9', undefined]]) assert.deepEqual(comesUp(id, title), [])
  // A title service that fails never stops the session from getting its role prompt.
  let prompted = 0
  const failing = new Driver({ logger: { warn() {} }, get: () => ({ get() { throw new Error('gone') } }) }, f.store, c => c)
  f.store.append(f.projectId, { type: 'session.bound', key: workerKey(f.threadId), sessionId: 's-10', assignee: 'engineer' })
  failing.registerScoped({ id: 's-10', ctx: { on: () => () => {}, systemPrompt: { section() { prompted++ } } }, session: { requestHeader: () => undefined } })
  assert.equal(prompted, 1)
  // A new task session gets the short title from the start; the project conversation keeps the project's name.
  const named = []
  const driver = new Driver({ logger: { warn() {} }, get: () => ({ rename: (_session, title) => { named.push(title) } }) }, f.store, c => c)
  driver.nameSession({ id: 's-new', session: {} }, f.project, f.project.threads.get(f.threadId), { name: '工程师' })
  driver.nameSession({ id: 's-chat', session: {} }, f.project, undefined, { id: COORDINATOR, name: '项目助理' })
  assert.deepEqual(named, ['写简介', '试玩'])
})

test('in a task session the executor answers the owner in plain text, and no role writes internal ids to the owner', t => {
  const f = fixture(t)
  const worker = rolePrompt(f.project, workerKey(f.threadId))
  // The owner reads a task's DSH session directly, so text is seen there; only woken turns need a platform tool to be seen.
  // 2026-11-19, after Claude Projects' thread prompt: one outlet per turn. Files go out with the answer in one post_message,
  // never as a post plus a text reply that narrates where the post went (「已发到任务消息里」).
  assert.match(worker, /一轮只用一个出口，同一件事不说两遍/)
  assert.match(worker, /直接用文字回答，答完就结束/)
  assert.match(worker, /要交文件，就用一次 post_message 把回答和文件一起发出/)
  for (const key of [COORDINATOR, MIRA, workerKey(f.threadId)]) assert.match(rolePrompt(f.project, key), /别讲幕后怎么运作：不说「线程」「群聊」「卡片」「收件箱」「任务消息」/)
  assert.match(worker, /被 <mira-wake> 唤醒的回合，要让用户知道的事只用平台工具发/)
  assert.match(worker, /回合里写下的纯文本不进项目记录、不算回复，但用户打开这个会话也看得到/)
  assert.doesNotMatch(worker, /谁也看不到/)
  for (const key of [COORDINATOR, MIRA, workerKey(f.threadId)]) assert.match(rolePrompt(f.project, key), /不写内部编号：消息 id（m_ 开头）、线程 id（t_ 开头）/)
})

test('Mira creates a project on the owner\'s words, the same way the page does, and a retry does not make a second one', t => {
  const f = fixture(t)
  const before = f.store.projects.size
  const asked = f.say('帮我建个项目叫「周报助手」，每周五把各项目进展汇成一页')
  const made = f.personal.createProject({ name: '周报助手', instructions: '每周五把各项目进展汇成一页' }, { messageId: asked })
  const project = f.store.get(made.projectId)
  assert.equal(project.name, '周报助手')
  assert.equal(project.instructions, '每周五把各项目进展汇成一页')
  // Like the page: no preset executors, only the project assistant and Mira.
  assert.deepEqual(project.members.map(m => m.id), ['owner', 'coordinator', MIRA])
  assert.equal(f.store.projects.size, before + 1)
  const action = f.personal.snapshot().actions.at(-1)
  assert.equal(action.kind, 'project')
  assert.equal(action.projectId, made.projectId)
  assert.match(action.text, /新建了项目「周报助手」/)
  // Calling again for the same words and name returns the same project instead of a duplicate.
  const again = f.personal.createProject({ name: '周报助手' }, { messageId: asked })
  assert.equal(again.projectId, made.projectId)
  assert.equal(again.existing, true)
  assert.equal(f.store.projects.size, before + 1)
  // Only on the owner's own words; a name is required; a folder must already exist on the DSH machine.
  assert.throws(() => f.personal.createProject({ name: 'x' }, { messageId: f.say('我替你建了', 'assistant') }), /用户本人的原话/)
  assert.throws(() => f.personal.createProject({ name: 'x' }, { messageId: '' }), /用户本人的原话/)
  assert.throws(() => f.personal.createProject({ name: ' ' }, { messageId: asked }), /项目名/)
  assert.throws(() => f.personal.createProject({ name: 'x', cwd: '/no/such/folder' }, { messageId: asked }), /已存在文件夹/)
  assert.equal(f.store.projects.size, before + 1)
  // Mira is told she can do it.
  assert.match(hubRolePrompt(f.hubStore.get(HUB_ID)), /新建一个项目（hub_project_create）/)
})

test('no roles: a task without an assignee goes to the project\'s one executor, made on first need; older executors still take their tasks', async t => {
  const f = fixture(t)
  const { projectId } = f.personal.createProject({ name: '打标试验' }, { messageId: f.say('建个项目叫「打标试验」') })
  const project = f.store.get(projectId)
  // Only the owner, the project assistant (not called 协调员) and Mira.
  assert.deepEqual(project.members.map(m => m.id), ['owner', COORDINATOR, MIRA])
  assert.equal(project.members.find(m => m.id === COORDINATOR).name, '项目助理')
  const revision = project.configRevision
  // The first task makes the executor; it runs on the project's default model and does not restart running sessions.
  const first = f.actions.openThread(project, { title: '定标签', brief: '出标签表' })
  const executor = project.members.find(m => m.id === EXECUTOR_ID)
  assert.deepEqual([executor.kind, executor.role, executor.name, executor.active, executor.modelSelection, executor.runtimeSelection], ['assistant', 'worker', '执行者', true, null, null])
  assert.equal(project.threads.get(first.threadId).assignee, EXECUTOR_ID)
  assert.equal(project.configRevision, revision)
  // The card line in the project conversation names no role.
  const card = project.events.findLast(e => e.type === 'message.posted' && e.card?.threadId === first.threadId)
  assert.equal(card.text, '开了任务。')
  assert.deepEqual(card.mentions, [])
  // A note is shown as written, without an @ in front.
  const second = f.actions.openThread(project, { title: '核标签', brief: '抽查 20 条', note: '先抽设计稿那批' })
  assert.equal(project.events.findLast(e => e.type === 'message.posted' && e.card?.threadId === second.threadId).text, '先抽设计稿那批')
  // The same executor takes every task: no member per task.
  assert.equal(project.members.filter(m => m.role === 'worker').length, 1)
  assert.equal(project.threads.get(second.threadId).assignee, EXECUTOR_ID)
  // A name that is not an executor is refused, and nothing is written.
  const seq = project.seq
  assert.throws(() => f.actions.openThread(project, { title: '画图', brief: '出图', assignee: '设计师' }), /一般不填/)
  assert.throws(() => f.actions.openThread(project, { title: '画图', brief: '出图', assignee: '项目助理' }), /一般不填/)
  assert.throws(() => f.actions.openThread(project, { title: '', brief: '出图' }), /title/)
  assert.equal(project.seq, seq)
  // Projects made before keep their executors, and naming one still gives it the task.
  assert.deepEqual(f.project.members.filter(m => m.role === 'worker').map(m => m.name), ['工程师', '设计师', '研究员'])
  const legacy = f.actions.openThread(f.project, { title: '改接口', brief: '加一个字段', assignee: '工程师' })
  assert.equal(f.project.threads.get(legacy.threadId).assignee, 'engineer')
  assert.match(f.project.events.findLast(e => e.type === 'message.posted' && e.card?.threadId === legacy.threadId).text, /@工程师/)
  // It survives a restart.
  const replay = new ProjectStore(f.root, { warn() {} }); replay.load()
  assert.equal(replay.get(projectId).members.find(m => m.id === EXECUTOR_ID).name, '执行者')
  // The assistant is told there are no roles, to leave assignee empty, and that machines cannot be chosen yet; no add_member.
  const prompt = rolePrompt(project, COORDINATOR)
  assert.match(prompt, /没有“角色”这一层/)
  assert.match(prompt, /不填 assignee/)
  assert.match(prompt, /跑在哪台机器上现在还不能选/)
  assert.doesNotMatch(prompt, /add_member/)
  // Executors are per task and not in the roster; an older project's stored persona gets the new wording.
  assert.doesNotMatch(prompt, /@执行者（/)
  assert.doesNotMatch(rolePrompt(f.project, COORDINATOR), /@工程师（/)
  assert.doesNotMatch(prompt, /按需新建执行者/)
  assert.match(prompt, /要动手时开成任务交给执行者/)
})

test('a removed executor stays removed: the next task gets a fresh one, and a name already taken is not reused', async t => {
  const f = fixture(t)
  const { projectId } = f.personal.createProject({ name: '换人试验' }, { messageId: f.say('建个项目叫「换人试验」') })
  const project = f.store.get(projectId)
  // A task that is refused (no title) makes no executor either.
  assert.throws(() => f.actions.openThread(project, { title: '', brief: '做一件' }), /title/)
  assert.equal(project.members.some(m => m.role === 'worker'), false)
  // A project made before 2026-11-13 stores the older wording for its assistant; the prompt gives the new one.
  const asIs = project.members.filter(m => m.kind === 'assistant' && m.active !== false).map(({ id, name, role, persona }) => ({ id, name, role, persona: id === COORDINATOR ? OLD_COORDINATOR_PERSONA : persona }))
  await f.actions.configureProject({ projectId, expectedRevision: project.configRevision ?? 0, name: '换人试验', instructions: '', members: asIs })
  assert.equal(project.members.find(m => m.id === COORDINATOR).persona, OLD_COORDINATOR_PERSONA)
  assert.doesNotMatch(rolePrompt(project, COORDINATOR), /按需新建执行者/)
  assert.match(rolePrompt(project, COORDINATOR), /要动手时开成任务交给执行者/)
  // The owner already has someone called 执行者 (made in settings): the project's executor takes another name.
  const keep = project.members.filter(m => m.kind === 'assistant' && m.active !== false).map(({ id, name, role, persona }) => ({ id, name, role, persona }))
  await f.actions.configureProject({ projectId, expectedRevision: project.configRevision ?? 0, name: '换人试验', instructions: '', members: [...keep, { name: '执行者', role: 'worker', persona: '手动建的' }] })
  const manual = project.members.find(m => m.name === '执行者')
  assert.ok(manual.id.startsWith('a_'))
  const { threadId } = f.actions.openThread(project, { title: '第一件', brief: '做一件' })
  assert.equal(project.threads.get(threadId).assignee, EXECUTOR_ID)
  assert.equal(project.members.find(m => m.id === EXECUTOR_ID).name, '默认执行者')
  // Saving the settings form as it stands (the executor included, with a model picked) keeps the same executor.
  const all = project.members.filter(m => m.kind === 'assistant' && m.active !== false).map(({ id, name, role, persona }) => ({ id, name, role, persona }))
  await f.actions.configureProject({ projectId, expectedRevision: project.configRevision, name: '换人试验', instructions: '', members: all.map(m => m.id === EXECUTOR_ID ? { ...m, modelSelection: { provider: 'ds', model: 'pro' } } : m) })
  assert.deepEqual([project.members.find(m => m.id === EXECUTOR_ID).active, project.members.find(m => m.id === EXECUTOR_ID).modelSelection], [true, { provider: 'ds', model: 'pro' }])
  assert.equal(f.actions.executorOf(project).id, EXECUTOR_ID)
  // The owner removes the project's executor once its task is closed; the next task gets a new one under a fresh id.
  f.actions.ownerUpdateThread({ projectId, threadId, state: 'done' })
  f.store.append(projectId, { type: 'inbox.acked', key: workerKey(threadId), cursor: project.seq })
  const others = project.members.filter(m => m.kind === 'assistant' && m.active !== false && m.id !== EXECUTOR_ID).map(({ id, name, role, persona }) => ({ id, name, role, persona }))
  await f.actions.configureProject({ projectId, expectedRevision: project.configRevision, name: '换人试验', instructions: '', members: others })
  assert.equal(project.members.find(m => m.id === EXECUTOR_ID).active, false)
  const next = f.actions.openThread(project, { title: '第二件', brief: '再做一件' })
  const fresh = project.members.find(m => m.id === project.threads.get(next.threadId).assignee)
  assert.match(fresh.id, /^executor_[0-9a-f]{8}$/)
  assert.equal(fresh.active, true)
  // And it is reused after that; a blank assignee is no name at all.
  const third = f.actions.openThread(project, { title: '第三件', brief: '还做一件', assignee: '  ' })
  assert.equal(project.threads.get(third.threadId).assignee, fresh.id)
})

// A DSH host with just enough to create, resume and wake sessions.
function host(f) {
  const agents = new Map(), followups = []
  const ctx = { logger: { warn() {} }, agents: { get: id => agents.get(id) }, get: () => undefined, sessions: { async flush() {} } }
  const text = { rolePrompt: () => 'role', wakeText: (_p, _k, _u, _r, notice) => `<mira-wake>${notice}`, continuityNotice: () => '[接续]', nudge: 'nudge', unanswered: 'unanswered' }
  const driver = new Driver(ctx, f.store, c => c, text)
  driver.controller = {
    async create(request) {
      const agent = { id: request.sessionId, status: 'idle', session: { id: request.sessionId, requestHeader: () => undefined }, ctx: { on() { return () => {} }, systemPrompt: { section() {} } },
        followup(content) { followups.push({ session: request.sessionId, text: content[0].text }) }, async whenIdle() {} }
      agents.set(agent.id, agent)
      return { sessionId: agent.id }
    },
    async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: new Error('not found') } },
  }
  return { driver, followups }
}

test('the project conversation is the project assistant\'s own DSH session: made when opened, reused, replaced after settings change with its continuity notice kept', async t => {
  const f = fixture(t), { driver, followups } = host(f)
  const first = await driver.openChat(f.project)
  assert.equal(f.project.sessions.get(COORDINATOR).sessionId, first)
  assert.equal(await driver.openChat(f.project), first, 'opening again shows the same conversation')
  const assistants = f.project.members.filter(m => m.kind === 'assistant' && m.active !== false).map(({ id, name, role, persona }) => ({ id, name, role, persona }))
  await f.actions.configureProject({ projectId: f.projectId, expectedRevision: 0, name: f.project.name, instructions: '新说明', members: assistants })
  const next = await driver.openChat(f.project)
  assert.notEqual(next, first)
  // Opening made the replacement, so its first wake still says it continues earlier records.
  f.actions.ownerPost({ projectId: f.projectId, text: '进展怎么样' })
  await driver.run(f.projectId, COORDINATOR, { running: false, again: false, reason: 'message', wokenThrough: 0 })
  assert.equal(followups[0].session, next)
  assert.match(followups[0].text, /\[接续\]/)
})

test('words the owner types in the project conversation are recorded as the owner\'s, wake nobody, and the assistant cites them with "latest"', t => {
  const f = fixture(t)
  const before = f.project.events.length
  const { messageId } = f.actions.mirrorNativeChat({ projectId: f.projectId, text: '帮我把首页文案改短一点' })
  const event = f.project.events.slice(before).find(e => e.messageId === messageId)
  assert.deepEqual([event.threadId, event.author.kind, event.trust, event.native], [null, 'human', 'principal', true])
  assert.deepEqual(event.to, [], 'the assistant already has these words in its session')
  assert.equal(f.store.unread(f.project, COORDINATOR).some(e => e.messageId === messageId), false)
  // A thread message is not "latest" for the project conversation.
  f.actions.mirrorNativeMessage({ projectId: f.projectId, threadId: f.threadId, text: '这是任务里的话' })
  const { threadId } = f.actions.openThread(f.project, { title: '改首页文案', brief: '改短', assignee: '工程师', cite_message_ids: ['latest'] })
  assert.deepEqual(f.project.threads.get(threadId).cited, [messageId])
  // Nothing typed yet in a project's conversation: "latest" cites nothing rather than guessing.
  const other = f.store.get(f.actions.createProject({ name: '空项目' }).projectId)
  const { threadId: none } = f.actions.openThread(other, { title: '空', brief: '空', assignee: '工程师', cite_message_ids: ['latest'] })
  assert.deepEqual(other.threads.get(none).cited, [])
  // The assistant is told how to cite in its own conversation.
  assert.match(rolePrompt(f.project, COORDINATOR), /cite_message_ids 填 "latest"/)
})

test('in its own conversation the project assistant speaks in plain text every turn; its final answer is recorded and counts as the reply', t => {
  const f = fixture(t)
  // Prompt and wake text (the wake text also reaches sessions started before) say so; executors keep the woken-turn rule.
  const coordinator = rolePrompt(f.project, COORDINATOR), worker = rolePrompt(f.project, workerKey(f.threadId))
  assert.match(coordinator, /每一轮（不管是他直接说话，还是被 <mira-wake> 唤醒）都直接用文字对他说/)
  assert.doesNotMatch(coordinator, /要让用户知道的事只用平台工具发/)
  assert.match(worker, /这种回合都必须以一次平台工具调用收尾/)
  const event = f.actions.ownerPost({ projectId: f.projectId, text: '进展怎么样' })
  const unread = f.store.unread(f.project, COORDINATOR)
  assert.match(wakeText(f.project, COORDINATOR, unread, 'message'), /你写的文字用户看得到：要对他说的直接用文字说/)
  assert.match(wakeText(f.project, workerKey(f.threadId), unread, 'message'), /本轮必须以一次平台工具调用收尾/)
  void event
  // Only a turn's final answer counts: text that comes with a tool call is the model thinking aloud.
  assert.equal(finalText({ content: [{ type: 'text', text: '我先看看' }, { type: 'tool-call', id: 'c', name: 'list_threads' }] }), '')
  assert.equal(finalText({ content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '两条在跑，' }, { type: 'text', text: '一条等你验收。' }] }), '两条在跑，\n一条等你验收。')
  assert.equal(finalText(undefined), '')
  const { messageId } = f.actions.mirrorAssistantText({ projectId: f.projectId, text: '两条在跑，一条等你验收。' })
  const posted = f.project.events.find(e => e.messageId === messageId)
  assert.deepEqual([posted.threadId, posted.author.id, posted.trust, posted.native], [null, COORDINATOR, 'relay', true])
  assert.deepEqual(posted.to, [])
  // The woken turn it answered in text needs no nudge.
  const driver = new Driver({ logger: { warn() {} } }, f.store, c => c)
  const turn = { platform: false, replied: false }
  driver.turns.set('s-chat', turn)
  driver.replied('s-chat')
  assert.deepEqual([turn.platform, turn.replied], [true, true])
  driver.replied('s-unknown')
})

test('Mira\'s conversation is her own DSH session: words typed there are the owner\'s, her text answer is recorded, and "latest" confirms an acceptance', async t => {
  const f = fixture(t)
  // Opening Mira makes (then reuses) her own session.
  const { driver } = host({ store: f.hubStore })
  const hub = f.hubStore.get(HUB_ID)
  const session = await driver.openChat(hub, MIRA)
  assert.equal(hub.sessions.get(MIRA).sessionId, session)
  assert.equal(await driver.openChat(hub, MIRA), session)
  // Typed words are the owner's own, recorded without waking her again.
  f.deliver()
  const asked = f.personal.mirrorNative({ text: '帮我把写简介验收了' })
  const event = hub.events.find(e => e.messageId === asked.messageId)
  assert.deepEqual([event.author.kind, event.trust, event.native], ['human', 'principal', true])
  assert.deepEqual(event.to, [])
  // Before she has said anything, "latest" cannot confirm an acceptance.
  await assert.rejects(f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: 'latest' }), /先用hub_reply/)
  const reply = f.personal.mirrorReply({ text: '合并后收不回，回「确认」我就去验收' })
  assert.equal(hub.events.find(e => e.messageId === reply.messageId).author.id, MIRA)
  f.personal.mirrorNative({ text: '确认' })
  await f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: 'latest' })
  assert.equal(f.project.threads.get(f.threadId).state, 'done')
  assert.match(f.personal.snapshot().actions.at(-1).sourceMessageId, /^m_/, '"latest" is recorded as the real message')
  await assert.rejects(f.personal.acceptTask({ projectId: f.projectId, threadId: f.threadId, confirmMessageId: 'latest' }), /已经用过/)
  // Her prompt says how to answer in her own session and how to cite typed words.
  const prompt = hubRolePrompt(hub)
  assert.match(prompt, /直接打字的那一轮他就在看你这个会话：直接用文字回答/)
  assert.match(prompt, /填 "latest"/)
})

test('a task wake says how long ago the owner wrote there and how many messages went out since', () => {
  const now = 1_800_000_000_000
  const project = { events: [
    { type: 'message.posted', threadId: 't_a', author: { kind: 'human', id: 'owner' }, at: now - 45 * 60e3 },
    { type: 'message.posted', threadId: 't_a', author: { kind: 'assistant', id: 'executor' }, at: now - 40 * 60e3 },
    { type: 'message.posted', threadId: 't_b', author: { kind: 'assistant', id: 'executor' }, at: now - 39 * 60e3 },
    { type: 'message.posted', threadId: 't_a', author: { kind: 'assistant', id: 'executor' }, at: now - 30 * 60e3 },
  ] }
  assert.equal(cadenceLine(project, workerKey('t_a'), now), '他上次在这个任务里说话是45 分钟前，那之后你发了 2 条消息。')
  assert.equal(cadenceLine(project, workerKey('t_c'), now), '', '他没在这个任务里说过话就不写')
  assert.equal(cadenceLine(project, COORDINATOR, now), '')
  project.events.push({ type: 'message.posted', threadId: 't_a', author: { kind: 'human', id: 'owner' }, at: now - 20e3 })
  assert.equal(cadenceLine(project, workerKey('t_a'), now), '他上次在这个任务里说话是不到 1 分钟前，那之后你发了 0 条消息。')
})
