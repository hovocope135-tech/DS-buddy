/**
 * Browser routes on the DSH `/api` channel. Connection authenticates them with
 * the DSH browser cookie and lets only the owner Peer through, so the
 * handlers trust the caller as the project owner.
 */

import { COORDINATOR, MIRA, PERSONAL_NAME, STARTER_MEMBERS, workerKey } from './store.js'
import { STATE_LABEL } from './protocol.js'
import { homedir } from 'node:os'
import { dockHtml } from './dock.js'
import { HUB_ID, todayView } from './hub.js'
import { cardCovered } from './today.js'
import { diaryHtml } from './dream.js'
import { todayHtml } from './today-page.js'
import { conversationDetail, historyWindowDetail, workersView } from './workers-view.js'
import { workersHtml } from './workers-page.js'
import { decodeFileChunk } from './files.js'
import { sessionHistory, taskExperience } from './task-experience.js'
import { runtimeView } from './external-runtime.js'
import { agentProfile } from './agent-profile.js'

export const STATE_PATH = '/api/mira-projects/state'
export const ACTION_PATH = '/api/mira-projects/action'
export const DOCK_PATH = '/api/mira-projects/dock'
export const TODAY_PATH = '/api/mira-projects/today'
export const TODAY_VIEW_PATH = '/api/mira-projects/today/view'
export const DREAM_DIARY_PATH = '/api/mira-projects/dream/diary'
export const WORKERS_PATH = '/api/mira-projects/workers'
export const WORKERS_VIEW_PATH = '/api/mira-projects/workers/view'
export const MODELS_PATH = '/api/mira-projects/models'
export const AGENT_PATH = '/api/mira-projects/agent'
export const FILE_PATH = '/api/mira-projects/file'
const LONG_POLL_MS = 20_000
const executionChildren = (driver, id) => driver.descendantsOf?.(id) ?? driver.childrenOf(id)

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function memberName(project, author) {
  if (author?.kind === 'human') return '我'
  if (author?.kind === 'system') return '系统'
  return project.members.find(m => m.id === author?.id)?.name ?? author?.id ?? ''
}

function message(project, id) {
  const m = project.messages.get(id)
  return {
    id: m.id, seq: m.seq, at: m.at, threadId: m.threadId, trust: m.trust, text: m.text, native: m.native === true,
    author: { ...m.author, name: m.via === 'personal' ? PERSONAL_NAME : memberName(project, m.author) },
    mentions: m.mentions, card: m.card ?? null, reactions: m.reactions,
    ...(m.handoff ? { handoff: { id: m.handoff.id, sourceRef: m.handoff.sourceRef, sourceMessageId: m.handoff.sourceMessageId, ...(m.handoff.note ? { note: m.handoff.note } : {}) } } : {}),
    attachments: m.attachments.map(item => {
      const file = [...project.files.values()].find(file => file.id === item.fileId)?.versions.at(-1)
      return { ...item, latestRevision: file?.revision ?? item.revision }
    }),
  }
}

/** While a task is with Claude Code / Codex: the DSH session it had before, which it goes back to. Null otherwise. */
function dshSessionOf(project, key) {
  const bound = project.sessions.get(key)
  if (bound === undefined || (bound.runtime ?? 'dsh') === 'dsh') return null
  return project.events.findLast(e => e.type === 'session.bound' && e.key === key && (e.runtime ?? 'dsh') === 'dsh' && (e.node ?? 'local') === 'local')?.sessionId ?? null
}

/**
 * The model a task's DSH session is known to run on, or null: not DSH, no session yet, or not seen since this
 * process started (DSH's default is not reported then, so an old session is never shown under a new default).
 */
function taskModel(driver, project, thread) {
  const session = project.sessions.get(workerKey(thread.id))
  if (session === undefined || (session.runtime ?? 'dsh') !== 'dsh') return null
  const seen = driver.modelOf?.(session.sessionId)
  return seen?.source === 'session' ? { provider: seen.provider, model: seen.model } : null
}

function card(project, thread, driver, deviceExecutions) {
  const key = workerKey(thread.id)
  const session = project.sessions.get(key)
  const sessions = sessionHistory(project, key)
  const children = sessions.flatMap(s => executionChildren(driver, s.id).map(c => ({ ...c, parentId: c.parentId ?? s.id, rootSessionId: s.id })))
  const experience = taskExperience(thread, { status: driver.status(project.id, key), children, lastTurn: project.turns.get(key), devices: deviceExecutions.get(project.id + '|' + key) }, project.decisions)
  const attached = new Map(thread.messageIds.flatMap(id => (project.messages.get(id)?.attachments ?? []).map(item => [item.fileId, item])))
  return {
    id: thread.id, title: thread.title, brief: thread.brief, note: thread.note,
    relatedThreadId: thread.relatedThreadId ?? null,
    assignee: thread.assignee, assigneeName: project.members.find(m => m.id === thread.assignee)?.name ?? thread.assignee,
    priority: thread.priority, state: thread.state, summary: thread.summary, checklist: thread.checklist,
    workspace: thread.workspace ?? null,
    gitlab: thread.gitlab ?? null,
    resolved: thread.resolved, openedAt: thread.openedAt, updatedAt: thread.updatedAt,
    cardMessageId: thread.cardMessageId, decisionIds: thread.decisionIds,
    attachments: [...attached.values()].map(item => ({ ...item,
      latestRevision: [...project.files.values()].find(file => file.id === item.fileId)?.versions.at(-1)?.revision ?? item.revision })),
    cited: thread.cited.filter(id => project.messages.has(id)).map(id => message(project, id)),
    timeline: timeline(project, thread),
    sessionId: session?.sessionId ?? null, generation: session?.generation ?? 0, continuity: session?.continuity === true,
    runtime: runtimeView(session),
    // v4 harness: who the next round goes to, whether the owner is driving, and the last change of hands.
    runner: driver.external?.provider(project, key) ?? 'dsh',
    dshSessionId: dshSessionOf(project, key),
    held: thread.heldAt ? { at: thread.heldAt } : null,
    // The task's own model pick, and the model its DSH session runs on now (or will start on).
    modelSelection: thread.modelSelection ?? null,
    model: taskModel(driver, project, thread),
    handoff: thread.handoff ?? null,
    status: driver.status(project.id, key),
    lastTurn: project.turns.get(key) ?? null,
    activity: project.activity.get(key) ?? null,
    toolCalls: Object.fromEntries(project.toolCalls.get(key) ?? []),
    inputs: shownInputs(thread.inputs ?? [], [thread.workspace?.cwd, project.cwd]),
    children, experience,
    sessions: sessions.map(s => ({ ...s, current: s.id === session?.sessionId })),
  }
}

/**
 * The files a task read, as the task board shows them: relative to the task's or project's folder, and `~` for the home
 * folder, so the page (and a screenshot of it) never shows the machine's user name. Same file twice shows once.
 */
export function shownInputs(paths, roots, home = homedir()) {
  const bases = roots.filter(Boolean).map(r => r.replace(/\/+$/, ''))
  const shown = paths.map(p => {
    for (const base of bases) if (p.startsWith(base + '/')) return p.slice(base.length + 1)
    return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
  })
  return [...new Set(shown)]
}

/** Messages, relays and the thread's own lifecycle events, in log order. */
function timeline(project, thread) {
  const rows = thread.messageIds.map(id => ({ kind: 'message', ...message(project, id) }))
  for (const relay of thread.relays) {
    rows.push({
      kind: 'relay', id: relay.id, seq: relay.seq, at: relay.at, text: relay.text,
      from: memberName(project, relay.from), toThread: relay.toThreadId ?? null, fromThread: relay.fromThreadId ?? null,
    })
  }
  for (const event of project.events) {
    const line = eventLine(project, thread, event)
    if (line !== undefined) rows.push({ kind: 'event', id: `e_${event.seq}`, seq: event.seq, at: event.at, ...line })
  }
  return rows.sort((a, b) => a.seq - b.seq)
}

/** One lifecycle event of a thread as a folded, avatar-less line (Raft: event lines, not messages). */
function eventLine(project, thread, event) {
  switch (event.type) {
    case 'thread.opened':
      return event.threadId === thread.id
        ? { text: `${memberName(project, event.openedBy)}开出任务，交给${project.members.find(m => m.id === event.assignee)?.name ?? event.assignee}`, tone: 'neutral' }
        : undefined
    case 'thread.updated': {
      if (event.threadId !== thread.id) return undefined
      // A worker asked for 「进行中」 while a question still waited: the state stayed and the timeline says why (bug 16, r10).
      if (Array.isArray(event.ignored) && event.ignored.includes('state')) {
        // The same request again (r24): the first row already says it.
        if (event.repeat === true) return undefined
        // A closed thread stays closed (r26): the row says who tried, and what did not happen.
        if (event.closed === true) return { text: `${memberName(project, event.by)}想把已关单的线程改为「${STATE_LABEL[event.wanted] ?? event.wanted}」，关了的线程不重开`, tone: 'neutral', held: true }
        const wanted = event.wanted === 'review_ready' ? '想直接交付「待验收」' : '想把状态改回「进行中」'
        return { text: `${memberName(project, event.by)}${wanted}，还有没答的拍板，保持「等你」`, tone: 'neutral', held: true }
      }
      const state = event.patch?.state
      if (state !== undefined) return { text: `${memberName(project, event.by)}把状态改为${STATE_LABEL[state] ?? state}`, tone: state, state }
      if (event.patch?.resolved === true) return { text: '归档', tone: 'closed' }
      if (event.patch?.resolved === false) return { text: '重新打开', tone: 'neutral' }
      return undefined
    }
    case 'decision.answered': {
      const decision = project.decisions.get(event.decisionId)
      if (decision === undefined || decision.threadId !== thread.id) return undefined
      return { text: `你拍板：${decision.options[event.chosen]?.label ?? event.chosen}`, tone: 'decision' }
    }
    case 'decision.withdrawn': {
      const decision = project.decisions.get(event.decisionId)
      if (decision === undefined || decision.threadId !== thread.id) return undefined
      return { text: `${memberName(project, event.by)}作废了拍板「${decision.question}」：${event.reason ?? ''}`, tone: 'closed' }
    }
    case 'turn.failed':
      if (event.key !== workerKey(thread.id)) return undefined
      // E2E #17: an outside runner that is installed but not signed in fails with its own raw error; say what to do next.
      if (thread.runner === 'claude' || thread.runner === 'codex') {
        const name = thread.runner === 'claude' ? 'Claude Code' : 'Codex'
        // A sign-in failure already says the way out (external-runtime.js signInError); anything else gets one.
        const error = String(event.error ?? '未知错误').replace(/[。.]\s*$/, '')
        return { text: `${name} 这一轮没跑起来：${error}。${/换回/.test(error) ? '' : '可以在「执行」里换回 DeepSeek Harness。'}`, tone: 'error' }
      }
      return { text: `这一轮没跑起来：${event.error ?? '未知错误'}`, tone: 'error' }
    case 'runtime.event': {
      if (event.key !== workerKey(thread.id) || event.kind !== 'tool') return undefined
      let label = event.text
      try {
        const value = JSON.parse(event.text)
        label = value.tool ?? value.name ?? value.item_type ?? value.type ?? event.text
      } catch { /* plain tool text */ }
      return { text: `外部执行：${String(label).slice(0, 180)}`, tone: 'neutral' }
    }
    case 'session.bound':
      return event.key === workerKey(thread.id) && event.continuity ? { text: '换了一段新对话接着做', tone: 'warning' } : undefined
    default:
      return undefined
  }
}

function miraCard(project, c) {
  const thread = c.threadId ? project.threads.get(c.threadId) : undefined
  return {
    id: c.id, kind: c.kind, title: c.title, body: c.body, threadId: c.threadId, threadTitle: thread?.title ?? null,
    // r28: 「回一句」 on a card about a closed thread goes to the chat — a post into the closed thread wakes nobody who can act.
    threadClosed: thread !== undefined && (thread.state === 'done' || thread.resolved === true),
    actions: c.actions, evidence: c.evidence, confidence: c.confidence, at: c.at, state: c.state, actedWith: c.actedWith, closedAt: c.closedAt, closedNote: c.closedNote ?? null,
  }
}

function assistant(project, key, driver) {
  const session = project.sessions.get(key)
  return {
    sessionId: session?.sessionId ?? null,
    status: driver.status(project.id, key),
    lastTurn: project.turns.get(key) ?? null,
    activity: project.activity.get(key) ?? null,
  }
}

/** Everything the floating dock needs across projects: what waits for the owner. */
function dock(store, driver, hubStore, deviceExecutions) {
  const cards = []
  const hub = hubStore?.projects.get(HUB_ID)
  for (const c of hub === undefined ? [] : hub.cardOrder.map(id => hub.cards.get(id)).filter(c => c.state === 'open' && cardCovered(c, store.projects) !== 'closed')) {
    // Hub cards act through the hub (projectId: hub) and jump into the project they point at.
    cards.push({
      ...miraCard(hub, c), projectId: HUB_ID, projectName: `个人助理${c.target?.projectName ? ` · ${c.target.projectName}` : ''}`,
      threadId: c.target?.threadId ?? null, threadTitle: c.target?.threadTitle ?? null, jumpProjectId: c.target?.projectId ?? null,
      evidence: c.refs ?? [], level: c.level ?? 'board', hub: true,
    })
  }
  const waiting = []
  const review = []
  const working = []
  for (const p of store.projects.values()) {
    for (const c of store.openCards(p)) cards.push({ projectId: p.id, projectName: p.name, ...miraCard(p, c) })
    for (const d of p.decisions.values()) {
      if (d.chosen !== null || d.withdrawn) continue
      waiting.push({ projectId: p.id, projectName: p.name, id: d.id, threadId: d.threadId, threadTitle: p.threads.get(d.threadId)?.title ?? '', question: d.question, options: d.options, recommended: d.recommended, at: d.at })
    }
    for (const t of p.threads.values()) {
      if (!t.resolved && t.state === 'review_ready') review.push({ projectId: p.id, projectName: p.name, id: t.id, title: t.title, summary: t.summary, assigneeName: p.members.find(m => m.id === t.assignee)?.name ?? t.assignee, updatedAt: t.updatedAt, gitlab: t.gitlab ?? null, usesGitlab: Boolean(p.gitlab) })
      const key = workerKey(t.id)
      const experience = taskExperience(t, { status: driver.status(p.id, key), children: sessionHistory(p, key).flatMap(s => executionChildren(driver, s.id)), devices: deviceExecutions.get(p.id + '|' + key) }, p.decisions)
      if (experience.execution.active) working.push({ projectId: p.id, projectName: p.name, threadId: t.id, title: t.title, who: p.members.find(m => m.id === t.assignee)?.name ?? t.assignee, activity: p.activity.get(key) ?? null, execution: experience.execution })
    }
    if (driver.status(p.id, COORDINATOR) === 'running') working.push({ projectId: p.id, projectName: p.name, threadId: null, title: '群聊', who: '项目助理', activity: p.activity.get(COORDINATOR) ?? null })
    if (p.hub) continue
    if (driver.status(p.id, MIRA) === 'running') working.push({ projectId: p.id, projectName: p.name, threadId: null, title: '整理记忆', who: '记忆助理', activity: p.activity.get(MIRA) ?? null })
  }
  cards.sort((a, b) => b.at - a.at)
  waiting.sort((a, b) => b.at - a.at)
  review.sort((a, b) => b.updatedAt - a.updatedAt)
  const recap = hub?.recaps.at(-1)
  const headline = recap !== undefined && recap.at > Date.now() - 20 * 60 * 60_000 ? { kind: recap.kind, headline: recap.headline, at: recap.at } : null
  return { cards, waiting, review, working, headline }
}

export function snapshot(store, driver, projectId, hubStore, devices, deviceExecutions = new Map()) {
  const projects = [...store.projects.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => {
      const threads = [...p.threads.values()].filter(t => !t.resolved)
      const navigation = p.threadOrder.map(id => p.threads.get(id)).map(t => ({
        id: t.id, title: t.title, state: t.state, resolved: t.resolved,
        // DSH tasks open their native Session; external tasks carry their provider and stay on the project task page.
        sessionId: p.sessions.get(workerKey(t.id))?.sessionId ?? null, updatedAt: t.updatedAt,
        runtime: runtimeView(p.sessions.get(workerKey(t.id))),
        dshSessionId: dshSessionOf(p, workerKey(t.id)),
        modelSelection: t.modelSelection ?? null, model: taskModel(driver, p, t),
        experience: taskExperience(t, { status: driver.status(p.id, workerKey(t.id)), children: sessionHistory(p, workerKey(t.id)).flatMap(s => executionChildren(driver, s.id)), lastTurn: p.turns.get(workerKey(t.id)), devices: deviceExecutions.get(p.id + '|' + workerKey(t.id)) }, p.decisions),
      }))
      return {
        id: p.id, name: p.name, icon: p.icon ?? null, color: p.color ?? null, updatedAt: p.updatedAt, desc: String(p.instructions ?? '').split('\n')[0].slice(0, 120),
        chatSessionId: p.sessions.get(COORDINATOR)?.sessionId ?? null,
        working: navigation.filter(t => t.experience.group === 'executing').length,
        waiting: threads.filter(t => t.state === 'blocked').length,
        review: threads.filter(t => t.state === 'review_ready').length,
        cards: store.openCards(p).length,
        // The workspace tree addresses conversations, independently of worker sessions.
        threads: navigation,
        busy: navigation.some(t => t.experience.execution.active) || [COORDINATOR, MIRA].some(key => driver.status(p.id, key) === 'running'),
      }
    })
  const p = projectId ? store.projects.get(projectId) : undefined
  const trash = [...store.trash.values()].sort((a, b) => b.deletedAt - a.deletedAt).map(t => ({ id: t.id, name: t.name, deletedAt: t.deletedAt, threads: t.threadOrder.length }))
  const base = { rev: store.rev + (hubStore?.rev ?? 0), projects, trash, dock: dock(store, driver, hubStore, deviceExecutions), runtimes: driver.external?.available?.() ?? { claude: false, codex: false } }
  if (p === undefined) return { ...base, project: null }
  return {
    ...base,
    project: {
      id: p.id, name: p.name, icon: p.icon ?? null, color: p.color ?? null, instructions: p.instructions, configRevision: p.configRevision ?? 0, cwd: p.cwd ?? null, workspace: p.workspace, gitlab: p.gitlab,
      // Keep configured next-wake selection separate from the model actually observed on a request.
      members: p.members.filter(m => m.active !== false).map(m => m.kind === 'assistant'
        ? { ...m, model: driver.memberModel?.(p, m.id) ?? null }
        : m),
      automations: [...p.automations.values()].filter(t => t.status !== 'deleted').map(({ occurrences, ...task }) => task),
      chat: p.chat.map(id => message(p, id)),
      files: [...p.files.values()].map(file => ({ ...file.versions.at(-1), versions: file.versions.map(v => v.revision) })),
      repository: p.repository,
      ...(devices ? { devices: devices.snapshot(p.id) } : {}),
      threads: p.threadOrder.map(id => card(p, p.threads.get(id), driver, deviceExecutions)),
      decisions: Object.fromEntries([...p.decisions].map(([id, d]) => [id, d])),
      coordinator: assistant(p, COORDINATOR, driver),
      mira: { ...assistant(p, MIRA, driver), pending: store.unread(p, MIRA).length, morningDay: p.morningDay },
      memory: p.memory,
      cards: p.cardOrder.map(id => miraCard(p, p.cards.get(id))),
    },
  }
}

/**
 * Register the routes.
 * @returns one disposer that removes them and releases waiting long-polls.
 */
export function registerRoutes(ctx, { store, driver, actions, mira, hub, gitlab, automations, files, repositories, devices }) {
  const disposeFile = ctx.connection.fetch.register({ path: FILE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      if (!files) throw new Error('项目文件服务尚未就绪')
      const query = new URL(request.url).searchParams, projectId = query.get('projectId')
      const { file, bytes } = await files.read(projectId, { file_id: query.get('fileId'), ...(query.has('revision') ? { revision: Number(query.get('revision')) } : {}) })
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.path.split('/').at(-1)),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" } })
    } catch (error) { return json({ error: String(error?.message ?? error) }, 400) }
  } })
  // One assistant's profile for the 助理 page: wake rules, the instructions it reads, model and harness, the strategy.
  const disposeAgent = ctx.connection.fetch.register({ path: AGENT_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      const query = new URL(request.url).searchParams
      return json(agentProfile({ store, driver, hub }, { projectId: query.get('projectId') || null, member: query.get('member') || '' }))
    } catch (error) { return json({ error: String(error?.message ?? error) }, 400) }
  } })
  const disposeModels = ctx.connection.fetch.register({ path: MODELS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async () => {
    try {
      const catalog = await driver.modelCatalog()
      // v4: with personal Mira on, also every assistant's configured and running model, for the 智能体 page.
      let agents, strategies
      try { if (hub?.personal) ({ agents, strategies } = await hub.personal.models(catalog)) } catch (error) { ctx.logger.warn('mira-projects: listing assistant models failed', error) }
      return json({ default: catalog.default, groups: catalog.groups, failures: (catalog.failures ?? []).map(f => ({ id: f.id, name: f.name })), ...(agents ? { agents } : {}), ...(strategies ? { strategies } : {}) })
    } catch { return json({ error: 'DSH 模型列表暂不可用' }, 503) }
  } })
  const waiters = new Set()
  const wakeAll = () => { for (const wake of [...waiters]) wake() }
  const unsubscribe = store.onChange(wakeAll)
  const unsubscribeHub = hub?.store.onChange(wakeAll)
  const rev = () => store.rev + (hub?.store.rev ?? 0)

  const waitForChange = (since, signal) => new Promise((resolve) => {
    if (rev() !== since) return resolve()
    const done = () => {
      waiters.delete(done)
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, LONG_POLL_MS)
    waiters.add(done)
    signal?.addEventListener('abort', done, { once: true })
    if (signal?.aborted) done()
  })

  // One lightweight notification can serve every view and browser tab. It
  // carries no domain content; each view still reads its authenticated source.
  const disposeRevision = ctx.connection.fetch.register({ path: '/api/mira-projects/revision', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    const query = new URL(request.url).searchParams, since = Number(query.get('since'))
    if (query.get('wait') === '1' && Number.isSafeInteger(since)) await waitForChange(since, request.signal)
    return json({ rev: rev() })
  } })

  const disposeState = ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const projectId = url.searchParams.get('project') || undefined
      const since = Number(url.searchParams.get('since'))
      const waiting = url.searchParams.get('wait') === '1' && Number.isFinite(since)
      if (waiting) await waitForChange(since, request.signal)
      try {
        const project = projectId ? store.projects.get(projectId) : undefined
        const observed = project ? [project] : [...store.projects.values()]
        for (const item of observed) {
          // Replaced main sessions can still own children. Their activity remains part of the task.
          await driver.refreshChildren([...new Set(item.events.filter(e => e.type === 'session.bound' && (e.runtime ?? 'dsh') === 'dsh' && e.key.startsWith('w:')).map(e => e.sessionId))])
        }
        if (project !== undefined) {
          // Opening the page is the moment for the morning card when the host was asleep at dawn.
          if (!waiting) mira?.maybeMorning(project)
        }
        const deviceExecutions = await devices?.executionStates([...store.projects.values()])
        return json(snapshot(store, driver, projectId, hub?.store, devices, deviceExecutions))
      } catch (error) {
        return json({ error: String(error?.message ?? error) }, 500)
      }
    },
  })

  const hubOnly = () => {
    if (hub === undefined) throw new Error('个人助理没有启动')
    return hub.actions
  }

  const dreamOnly = () => {
    if (!hub?.dream) throw new Error('个人助理没有启动')
    return hub.dream
  }

  const lookOnly = () => {
    if (!hub?.look) throw new Error('个人助理没有启动')
    return hub.look
  }

  const personalOnly = () => {
    if (!hub?.personal) throw new Error('当前环境未开启个人助理')
    return hub.personal
  }
  const disposePersonal = ctx.connection.fetch.register({ path: '/api/mira-projects/personal', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    const url = new URL(request.url), since = Number(url.searchParams.get('since'))
    if (url.searchParams.get('wait') === '1' && Number.isFinite(since)) await waitForChange(since, request.signal)
    if (!hub?.personal) return json({ enabled: false, rev: rev() })
    try { return json({ rev: rev(), ...personalOnly().snapshot({ ...(url.searchParams.has('before') ? { before: Number(url.searchParams.get('before')) } : {}) }) }) }
    catch (error) { return json({ error: String(error?.message ?? error) }, 400) }
  } })
  const disposeSource = ctx.connection.fetch.register({ path: '/api/mira-projects/personal/source', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try { return json(personalOnly().source(new URL(request.url).searchParams.get('ref'))) }
    catch (error) { return json({ error: String(error?.message ?? error) }, 400) }
  } })
  const observations = () => { if (!hub?.observations) throw new Error('当前环境未开启观察同步');return hub.observations }
  const disposeObservations = ctx.connection.fetch.register({ path: '/api/mira-projects/observations', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      const q = new URL(request.url).searchParams
      return json(observations().snapshot(Object.fromEntries([...q].map(([k, v]) => [k, ['limit', 'since', 'until'].includes(k) ? Number(v) : v]))))
    } catch (error) { return json({ error: error.message }, 400) }
  } })
  const disposeObservationImage = ctx.connection.fetch.register({ path: '/api/mira-projects/observation/image', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      const { bytes, mime } = await observations().image(new URL(request.url).searchParams.get('ref'))
      return new Response(bytes, { headers: { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } })
    } catch (error) { return json({ error: error.message }, error.code === 'IMAGE_UNAVAILABLE' ? 410 : 404) }
  } })

  // 截图来问: the page picks up a screenshot the shortcut handed in, and fetches the picture to put in the composer.
  const shots = () => { if (!hub?.shots) throw new Error('当前环境未开启截图来问');return hub.shots }
  const disposeShotImage = ctx.connection.fetch.register({ path: '/api/mira-projects/shot/image', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      const { bytes, mime } = shots().image(new URL(request.url).searchParams.get('id'))
      return new Response(bytes, { headers: { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } })
    } catch (error) { return json({ error: error.message }, error.code === 'IMAGE_UNAVAILABLE' ? 410 : 404) }
  } })

  const disposeToday = ctx.connection.fetch.register({
    path: TODAY_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const since = Number(url.searchParams.get('since'))
      const waiting = url.searchParams.get('wait') === '1' && Number.isFinite(since)
      if (waiting) await waitForChange(since, request.signal)
      try {
        // Opening the board is the moment for the morning or evening recap when the host slept through it.
        if (!waiting) { hub?.service.maybeMorning(); hub?.service.maybeEvening() }
        const deviceExecutions = await devices?.executionStates([...store.projects.values()]) ?? new Map()
        const view = todayView(store, hub?.store, { day: url.searchParams.get('day') || undefined, status: (p, k) => driver.status(p, k),
          execution: (p, t) => taskExperience(t, { status: driver.status(p.id, workerKey(t.id)),
            children: sessionHistory(p, workerKey(t.id)).flatMap(s => executionChildren(driver, s.id)),
            devices: deviceExecutions.get(p.id + '|' + workerKey(t.id)) }, p.decisions).execution })
        return json({ rev: rev(), hubStatus: hub ? hub.driver.status(HUB_ID, MIRA) : 'off', ...view, ...(hub?.history ? { computer: { live: hub.history.live() } } : {}), ...(hub?.dream ? { dream: hub.dream.view() } : {}) })
      } catch (error) {
        return json({ error: String(error?.message ?? error) }, 500)
      }
    },
  })

  const disposeTodayView = ctx.connection.fetch.register({
    path: TODAY_VIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(todayHtml(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    }),
  })

  // The developer view: what each background worker was given and what it wrote. Read-only.
  const disposeWorkers = ctx.connection.fetch.register({ path: WORKERS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    if (!hub?.history || !hub.followups || !hub.observations) return json({ error: '当前环境没有开启后台环节' }, 404)
    try {
      const q = new URL(request.url).searchParams, log = hub.store.get(HUB_ID), parts = { history: hub.history, followups: hub.followups, observations: hub.observations, autoMemory: hub.autoMemory }
      if (q.has('window')) return json(historyWindowDetail(log, parts, q.get('window')))
      if (q.has('conversation')) return json(conversationDetail(log, parts, q.get('conversation')))
      return json(workersView(log, parts, { day: q.get('day') || undefined }))
    } catch (error) { return json({ error: String(error?.message ?? error) }, 400) }
  } })
  const disposeWorkersView = ctx.connection.fetch.register({ path: WORKERS_VIEW_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => new Response(workersHtml(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }) })

  const disposeAction = ctx.connection.fetch.register({
    path: ACTION_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { return json({ error: '请求体不是 JSON' }, 400) }
      try {
        switch (body?.op) {
          case 'observationHello': return json(observations().hello(body.deviceId, body.name, body.report))
          case 'observationChunk': return json(await observations().chunk(body.deviceId, body))
          case 'observationIngest': return json(await observations().ingest(body.deviceId, body))
          case 'observationConfigure': return json(await observations().configure(body))
          case 'observationClearMedia': return json(await observations().clearMedia(body))
          case 'retentionConfigure': {
            if (!hub?.retention) throw new Error('当前环境未开启资料保留设置')
            return json(hub.retention.configure(body))
          }
          case 'retentionCollect': {
            if (!hub?.retention) throw new Error('当前环境未开启资料保留设置')
            return json(hub.retention.collect())
          }
          case 'connectorConfigure': {
            if (!hub?.connectors) throw new Error('当前环境未开启连接器')
            return json(hub.connectors.configure(body))
          }
          // v4: the owner sets aside a Feishu conversation that seemed to wait for their reply.
          case 'followupDismiss': {
            if (!hub?.followups) throw new Error('当前环境未开启待回复提醒')
            return json(hub.followups.dismiss({ conversation: body.conversation, through: body.through }))
          }
          // v4: the owner's own switch for Feishu reminders, and the two browser steps that connect live Feishu reading.
          case 'attentionMode': {
            if (!hub?.attention) throw new Error('当前环境未开启飞书主动提醒')
            return json(hub.attention.setMode(body.mode))
          }
          case 'feishuLiveStatus':
          case 'feishuLiveConnect': {
            if (!hub?.feishuLive) throw new Error('当前环境未开启飞书实时读取')
            return json(body.op === 'feishuLiveConnect' ? await hub.feishuLive.connect() : await hub.feishuLive.status())
          }
          // v4: reading the owner's computer. The page can see the state and pause it; only the assistant's tool asks for a read.
          case 'shotClaim': return json(shots().claim(body.id))
          case 'macFilesStatus':
          case 'macFilesMode': {
            if (!hub?.macFiles) throw new Error('当前环境未开启读电脑')
            return json(body.op === 'macFilesMode' ? hub.macFiles.setMode(body.mode) : hub.macFiles.status())
          }
          // v4: the command that reopens a task's Claude Code / Codex session in a terminal, made on demand.
          case 'takeover': {
            const project = store.projects.get(body.projectId)
            if (project === undefined || project.hub || !project.threads.has(body.threadId)) throw new Error('没有这个任务')
            if (!driver.external) throw new Error('当前环境未开启外部执行')
            return json(await driver.external.takeover(project, workerKey(body.threadId)))
          }
          case 'setTaskRunner': return json(actions.setTaskRunner({ projectId: body.projectId, threadId: body.threadId, provider: body.provider }))
          case 'setTaskModel': return json(await actions.setTaskModel({ projectId: body.projectId, threadId: body.threadId, provider: body.provider, model: body.model }))
          case 'holdTask': return json(actions.holdTask({ projectId: body.projectId, threadId: body.threadId }))
          case 'releaseTask': return json(actions.releaseTask({ projectId: body.projectId, threadId: body.threadId }))
          case 'personalPost': return json(personalOnly().post(body))
          case 'personalRetry': return json(personalOnly().retry(body))
          case 'personalHandoff': return json(personalOnly().handoff(body))
          // v4: Mira's conversation is her own DSH Session; opening it makes one when needed.
          case 'openMiraChat': personalOnly(); return json({ sessionId: await hub.driver.openChat(hub.store.get(HUB_ID), MIRA) })
          case 'setModel': return json(await personalOnly().setModel({ projectId: body.projectId, member: body.member, provider: body.provider, model: body.model }))
          case 'setModelStrategy': return json(personalOnly().setModelStrategy({ projectId: body.projectId || null, text: body.text }))
          case 'importRepository': {
            if (!repositories) throw new Error('仓库导入服务尚未就绪')
            return json(await repositories.import(body.projectId, body))
          }
          case 'fileChunk': {
            if (!files) throw new Error('项目文件服务尚未就绪')
            store.get(body.projectId)
            return json({ sha256: await files.blobs.put(body.projectId, decodeFileChunk(body.data)) })
          }
          case 'fileCommit': {
            if (!files) throw new Error('项目文件服务尚未就绪')
            return json(await files.commitUpload(body.projectId, 'owner', body))
          }
          case 'fileWrite': {
            if (!files) throw new Error('项目文件服务尚未就绪')
            return json(await files.writeText(body.projectId, 'owner', body))
          }
          case 'grantDevice':
          case 'revokeDevice': {
            if (!devices) throw new Error('设备桥尚未配置')
            const { op, projectId, ...input } = body
            return json(op === 'grantDevice' ? devices.grant(projectId, input) : devices.revoke(projectId, input))
          }
          // v4: a project from the page starts with the project assistant and Mira only; executors are added per task.
          case 'createProject': return json(actions.createProject({ ...body, members: STARTER_MEMBERS }))
          case 'configureProject': return json(await actions.configureProject(body))
          case 'deleteProject': return json(await actions.deleteProject(body))
          case 'restoreProject': return json(actions.restoreProject(body))
          case 'setProjectIcon': return json(actions.setProjectIcon(body))
          case 'createAutomation':
          case 'pauseAutomation':
          case 'resumeAutomation':
          case 'deleteAutomation': {
            if (!automations) throw new Error('自动任务服务尚未就绪')
            if (body.op === 'createAutomation') return json(await automations.create(body))
            if (body.op === 'resumeAutomation') return json(await automations.resume(body))
            return json(await automations.pause({ ...body, deleted: body.op === 'deleteAutomation' }))
          }
          case 'post': return json(actions.ownerPost(body))
          // v4: the project conversation is the project assistant's own DSH Session; opening it makes one when needed.
          case 'openChat': {
            const project = store.projects.get(body.projectId)
            if (project === undefined || project.hub) throw new Error('没有这个项目')
            return json({ sessionId: await driver.openChat(project) })
          }
          case 'answerDecision': return json(actions.answerDecision(body))
          case 'updateThread': {
            if (body.state === 'done' && store.get(body.projectId).gitlab) {
              if (!gitlab) throw new Error('GitLab 服务尚未就绪')
              return json(await gitlab.accept(body.projectId, body.threadId, body.expectedSha))
            }
            return json(actions.ownerUpdateThread(body))
          }
          case 'publishThread': {
            if (!gitlab) throw new Error('GitLab 服务尚未就绪')
            return json(await gitlab.publish(body.projectId, body.threadId))
          }
          case 'miraRun': return json(actions.miraRun(body))
          case 'cardAction': return json(body.projectId === HUB_ID ? hubOnly().cardAction(body) : actions.cardAction(body))
          case 'memoryForget': return json(actions.memoryForget(body))
          // 做梦: the owner's answer to a morning item, and a dream on demand (the same checks as the night's).
          case 'dreamReact': return json(dreamOnly().react(body))
          case 'dreamRun': return json({ ok: true, written: Boolean(await dreamOnly().run({ force: true })) })
          // 技能自迭代: the owner's choice on a drafted 做事说明, and keeping or going back after 先试一次.
          case 'skillDecide': return json(dreamOnly().decideSkill(body))
          case 'skillSettle': return json(dreamOnly().settleSkill(body))
          case 'skillDraft': return json({ ok: true, notes: await dreamOnly().proposeSkills() })
          // The 记忆 tab of the personal assistant: the owner's own hand on what she keeps about them.
          case 'aboutAdd': return json(hubOnly().aboutAdd(body))
          case 'aboutEdit': return json(hubOnly().aboutEdit(body))
          case 'aboutForget': return json(hubOnly().aboutForget(body))
          case 'aboutRestore': return json(hubOnly().aboutRestore(body))
          case 'aboutUndo': return json(hubOnly().aboutUndo(body))
          case 'aboutAck': return json(hubOnly().aboutAck(body))
          case 'assistantLook': return json(lookOnly().save(body.look))
          case 'assistantLookDraft': return json(await lookOnly().draft(body.sentence))
          case 'buttonSent': return json(hubOnly().cannedText(body))
          case 'hubMemoryForget': return json(hubOnly().memoryForget(body))
          case 'hubMemoryRestore': return json(hubOnly().memoryRestore(body))
          case 'hubRun': return json(hubOnly().request('owner', body.note))
          case 'ingest': return json(hubOnly().ingest(body.events))
          default: return json({ error: `未知操作：${String(body?.op)}` }, 400)
        }
      } catch (error) {
        return json({ error: String(error?.message ?? error), code: error?.code ?? 'INVALID_ACTION' }, 400)
      }
    },
  })

  // The diary page of one morning: rendered from checked text only.
  const disposeDiary = ctx.connection.fetch.register({ path: DREAM_DIARY_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    const day = new URL(request.url).searchParams.get('day'), log = hub?.store.get(HUB_ID)
    const done = log?.events.findLast(e => e.type === 'dream.done' && (!day || e.day === day))
    if (!done) return new Response('还没有日记', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    return new Response(diaryHtml(done, hub.look?.current?.() ?? null), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } })
  } })

  const disposeDock = ctx.connection.fetch.register({
    path: DOCK_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(dockHtml(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    }),
  })

  return async () => {
    unsubscribe()
    unsubscribeHub?.()
    wakeAll()
    await Promise.all([disposeRevision(), disposeState(), disposeAction(), disposeDock(), disposeToday(), disposeTodayView(), disposeModels(), disposeAgent(), disposeFile(), disposePersonal(), disposeSource(), disposeObservations(), disposeObservationImage(), disposeShotImage(), disposeWorkers(), disposeWorkersView(), disposeDiary()])
  }
}
