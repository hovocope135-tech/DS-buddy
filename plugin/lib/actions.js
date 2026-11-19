/**
 * Commands shared by the browser routes (the owner) and the assistant tools.
 * Each command appends events with their recipients and wakes those recipients.
 */

import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CARD_ACTIONS, CARD_KINDS, COORDINATOR, MEMORY_SECTIONS, MIRA, PRIORITIES, THREAD_STATES, THREAD_INPUTS_MAX, dayKey, workerKey, EXECUTOR_ID, EXECUTOR_MEMBER } from './store.js'
import { ThreadWorkspaces, repositoryAt, workspaceChanges } from './worktrees.js'
import { ownerIcon } from './project-icons.js'
import { RUNTIME_LABELS } from './external-runtime.js'
import { normalizeGitlab } from './gitlab.js'
import { normalizeMembers } from './members.js'

const MAX_TEXT = 20_000
const NOTIFY_COORDINATOR = new Set(['review_ready', 'failed', 'done', 'blocked'])
const MAX_OPEN_CARDS = 6
const DAILY_CARDS = 3
/** A thread in one of these states waits for nothing: its open decisions are moot. */
const RETIRES_DECISIONS = { review_ready: '线程已交付待验收', done: '线程已完成', failed: '线程已失败' }
/** Card kinds that describe a moment (what to do next, what is stuck) and go stale when it passes; recaps and captures stay. */
const STALE_KINDS = new Set(['next_step', 'reminder', 'open_loop'])
/** Sources with actual authored content or a user choice; bare status bookkeeping cannot establish a fact. */
const FACT_EVIDENCE = new Set(['project.created', 'project.configured', 'message.posted', 'thread.opened', 'decision.answered', 'relay.sent', 'workspace.ready', 'memory.fact.added'])
/**
 * bug ㉒ (cloud-run-14 #390): a chat line that speaks only to Mira but accepts or closes a thread must still reach the coordinator.
 * r20 (cloud-run-17 #335): 「…那个拍板作废了」 is a note about something that already happened, not a request — 作废 / 停掉 / 取消 dropped.
 * r22 (cloud-run-19 #401 「都关单了…别重复已经关掉的」, #416 「未收尾里那条…我要点头啥？」): bare keywords matched questions and
 * descriptions too. Only the shapes a user says when accepting or closing count now: 「这张我收了」「把卡片关掉」「验收过了」
 * 「置 done」「算了，归档吧」「先不做了」 — not 「已经关掉的」「都关单了」「未收尾」「待验收」.
 */
const CLOSING_ASKS = [
  /(?<![未没别不])收了(?!的)/,
  /(?<![未没别不待等要])验收(?:通过|过了|了)(?!的)/, /已验收|验过了/,
  /(?<![别不])把(?:(?!已经|都|早就|刚)[^，。！？!?]){0,8}?关(?:掉|了|单)(?!的)/, /关(?:掉|单|了)吧/, /(?:这张|那张|这条|那条|这个|那个|卡片)[^，。！？!?]{0,4}?关(?:掉|了|单)(?!的)/,
  /(?:置|设|改|标记?)\s*(?:为|成)?\s*done/i,
  /归档吧/,
  /收尾吧|可以收尾了/,
]
// r30 (cloud-run-27 #536): 「@Mira 翻页插卡那三个取舍先不做了，…把那条清掉」 gave up a row in Mira's memory, not a thread, yet
// 「先不做了」 woke the coordinator, who had nothing to add but 「这件事归 Mira 记，她已被点名」 (#539). Giving something up is his
// business only when it is a thread: the line has to name one (a thread's title, or 「线程」 itself); 「归档吧」 always is.
const DROP_ASKS = [/(?<![别不])(?:先不做了|不做了)/, /(?<![别不])算了(?:[，,。！!]|$)/]
const flat = s => String(s ?? '').replace(/\s+/g, '')
const asksToClose = text => CLOSING_ASKS.some(re => re.test(text))
const asksToDrop = (project, text) => DROP_ASKS.some(re => re.test(text))
  && (/线程/.test(text) || [...project.threads.values()].some(t => flat(t.title).length >= 4 && flat(text).includes(flat(t.title))))

const ACTION_LABEL = {
  open_thread: { label: '打开线程', tier: 'safe-read' },
  reply: { label: '回一句', tier: 'local-write' },
  save_memory: { label: '记下来', tier: 'local-write' },
  copy_text: { label: '复制', tier: 'safe-read' },
}

/**
 * v4: the text of a DSH assistant message that ends a turn, i.e. one with no tool call. Text that comes with a tool call
 * is the model thinking aloud on its way; reasoning is never shown. Empty when there is nothing to record.
 */
export function finalText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  if (content.some(block => block?.type === 'tool-call')) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text.trim()).filter(Boolean).join('\n')
}

/** Tool names that write rather than read; their paths are the task's output, not its input. */
const WRITE_TOOL = /write|edit|create|patch|delete|remove|move|rename|publish|upload/i

/**
 * The file paths a DSH assistant message's tool calls read or searched, for the task board's 输入. Only explicit path
 * arguments count; a shell command line is not parsed.
 */
export function toolPaths(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const out = []
  for (const block of content) {
    if (block?.type !== 'tool-call') continue
    const name = String(block.toolName ?? block.name ?? '')
    if (WRITE_TOOL.test(name)) continue
    let args = block.args ?? block.input ?? block.arguments ?? {}
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
    if (!args || typeof args !== 'object') continue
    for (const key of ['path', 'file_path', 'filePath', 'file', 'filename']) if (typeof args[key] === 'string' && args[key].trim()) out.push(args[key].trim())
    if (Array.isArray(args.paths)) for (const path of args.paths) if (typeof path === 'string' && path.trim()) out.push(path.trim())
  }
  return [...new Set(out)].filter(path => path.length <= 300)
}

function text(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 不能为空`)
  if (value.length > max) throw new Error(`${field} 太长（上限 ${max} 字）`)
  return value
}

function seqList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} 要是数字数组`)
  const clean = [...new Set(value.map(Number).filter(n => Number.isInteger(n) && n > 0))]
  if (clean.length > 12) throw new Error(`${field} 最多 12 条`)
  return clean
}

/** A model sometimes copies the platform's escaping back (`Q&amp;A`). The owner reads these fields as plain text. */
const plain = value => typeof value === 'string' ? value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&') : value

export class Actions {
  /**
   * @param {import('./store.js').ProjectStore} store
   * @param {import('./driver.js').Driver} driver
   */
  constructor(store, driver, { files } = {}) {
    this.store = store
    this.driver = driver
    this.files = files
    this.workspaces = new ThreadWorkspaces(store)
  }

  commit(projectId, event, reason) {
    const committed = this.store.append(projectId, event)
    this.driver.deliver(committed, reason)
    return committed
  }

  /** Cited message ids that exist in this project; unknown ids are dropped. */
  cites(project, ids) {
    // v4: words typed straight into the project conversation reach the assistant without an id; it cites them as
    // "latest", which is the owner's newest such message in that conversation (none yet: nothing is cited).
    const latest = () => project.events.findLast(e => e.type === 'message.posted' && e.native === true && e.threadId === null && e.author?.kind === 'human')?.messageId
    return [...new Set((Array.isArray(ids) ? ids : []).map(id => id === 'latest' ? latest() : id))].filter(id => typeof id === 'string' && project.messages.has(id)).slice(0, 8)
  }

  // ------------------------------------------------------------- owner

  createProject({ name, instructions, cwd, workspaceMode = 'auto', gitlab: gitlabConfig, members }) {
    const raw = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined
    const folder = raw === '~' || raw?.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw
    if (folder !== undefined && !(isAbsolute(folder) && statSync(folder, { throwIfNoEntry: false })?.isDirectory())) {
      throw new Error('项目目录要填 DSH 所在电脑上一个已存在文件夹的绝对路径')
    }
    if (!['auto', 'shared', 'worktree'].includes(workspaceMode)) throw new Error('workspaceMode 只能是 auto、shared 或 worktree')
    const repository = folder && workspaceMode !== 'shared' ? repositoryAt(folder) : null
    if (workspaceMode === 'worktree' && (!repository || repository.unavailable)) throw new Error(repository?.unavailable ?? '独立工作目录需要一个已有提交的 Git 仓库')
    const workspace = repository?.root ? { mode: 'worktree', repository: repository.root, subdirectory: repository.subdirectory } : { mode: 'shared', ...(repository?.unavailable ? { reason: repository.unavailable } : {}) }
    const gitlab = normalizeGitlab(gitlabConfig)
    if (gitlab && workspace.mode !== 'worktree') throw new Error('GitLab 交付需要独立 worktree，请选择已有提交的 Git 项目')
    const event = this.store.createProject({
      name: text(name, '项目名', 80),
      instructions: typeof instructions === 'string' ? instructions.slice(0, MAX_TEXT) : '',
      cwd: folder,
      workspace,
      gitlab,
      ...(members ? { members } : {}),
    })
    return { projectId: event.projectId }
  }

  /**
   * The project's executor, made the first time a task needs it. One per project: the owner sees the model doing the
   * work, not a role. No config revision, so running sessions keep running. A removed executor stays removed; a new one
   * takes its place under a fresh id.
   */
  executorOf(project) {
    const live = project.members.find(m => m.kind === 'assistant' && m.role === 'worker' && m.active !== false && (m.id === EXECUTOR_ID || m.id.startsWith(EXECUTOR_ID + '_')))
    if (live) return live
    const taken = new Set(project.members.map(m => m.id))
    const id = taken.has(EXECUTOR_ID) ? `${EXECUTOR_ID}_${randomBytes(4).toString('hex')}` : EXECUTOR_ID
    const names = new Set(project.members.filter(m => m.active !== false).map(m => m.name))
    const member = { ...EXECUTOR_MEMBER, id, name: names.has(EXECUTOR_MEMBER.name) ? '默认执行者' : EXECUTOR_MEMBER.name }
    this.store.append(project.id, { type: 'member.added', member, by: { kind: 'system' } })
    return project.members.find(m => m.id === id)
  }

  async configureProject({ projectId, expectedRevision, name, instructions, members: input }) {
    const project = this.store.get(projectId)
    const checkRevision = () => {
      if (!Number.isInteger(expectedRevision) || expectedRevision !== (project.configRevision ?? 0)) throw new Error('项目配置已变化，请刷新设置后再保存')
    }
    checkRevision()
    const title = text(name, '项目名', 80).trim()
    if (typeof instructions !== 'string' || instructions.length > MAX_TEXT) throw new Error('项目说明最多 20000 字')
    const members = normalizeMembers(input, project.members)
    const selected = members.filter(m => m.active !== false && m.modelSelection).map(m => m.modelSelection)
    if (selected.length) {
      const catalog = await this.driver.modelCatalog()
      for (const route of selected) if (!catalog.groups?.some(g => g.id === route.provider && g.models.some(m => m.id === route.model))) throw new Error(`模型不可用：${route.provider}/${route.model}；请从当前模型列表选择`)
    }
    checkRevision()
    const removed = project.members.filter(m => m.active !== false && !members.some(next => next.id === m.id && next.active !== false))
    for (const member of removed) {
      const threads = [...project.threads.values()].filter(t => t.assignee === member.id)
      if (threads.some(t => !t.resolved && t.state !== 'done')) throw new Error(`${member.name} 还有未完成线程，请先完成或归档`)
      if (threads.some(t => this.driver.status(project.id, workerKey(t.id)) !== 'idle' || this.store.unread(project, workerKey(t.id)).length)) throw new Error(`${member.name} 还有运行、排队或未读消息，请等处理结束`)
    }
    const keys = [...project.threads.values()].filter(t => !t.resolved && t.state !== 'done').map(t => workerKey(t.id))
    const event = this.commit(project.id, { type: 'project.configured', name: title, instructions, members, by: { kind: 'human', id: 'owner' }, to: ['coordinator', MIRA, ...keys] }, 'configuration')
    return { ok: true, configRevision: event.seq }
  }

  // ------------------------------------------------------------- v4 harness: who executes a task, and who is driving

  /** A task of an ordinary project (not the personal assistant's own), with its inbox key. */
  ownedTask(projectId, threadId) {
    const project = this.store.projects.get(projectId)
    const thread = project?.hub ? undefined : project?.threads.get(threadId)
    if (thread === undefined) throw new Error('没有这个任务')
    return { project, thread, key: workerKey(threadId), open: !thread.resolved && thread.state !== 'done' }
  }

  /** The executor a task's next round goes to: its own choice, else its member's default, else DSH. */
  runnerOf(project, key) {
    return this.driver.external?.provider(project, key) ?? 'dsh'
  }

  /**
   * What happened in a task after event `sinceSeq` and commit `sinceHead`: counted from the event log and from Git,
   * so the next one to hold the task is told facts, not a summary a model wrote.
   */
  handoffFacts(project, thread, sinceSeq, sinceHead) {
    const key = workerKey(thread.id)
    const later = project.events.filter(e => e.seq > sinceSeq)
    const posted = later.filter(e => e.type === 'message.posted' && e.threadId === thread.id)
    const directory = thread.workspace?.cwd ?? project.cwd
    return {
      sinceSeq,
      messages: posted.length,
      ownerMessages: posted.filter(e => e.author?.kind === 'human').length,
      turns: later.filter(e => e.type === 'turn.ended' && e.key === key).length,
      workspace: directory ? workspaceChanges(directory, sinceHead) : null,
    }
  }

  /**
   * Change who executes one task: DSH, Claude Code or Codex. Unlike a member's default this is no project
   * configuration: no revision changes, no other task is woken, and a turn that is running finishes with the
   * executor it started with; the next round goes to the new one.
   */
  setTaskRunner({ projectId, threadId, provider }) {
    const { project, thread, key, open } = this.ownedTask(projectId, threadId)
    if (!Object.hasOwn(RUNTIME_LABELS, provider)) throw new Error('执行者只能是 dsh、claude 或 codex')
    const from = this.runnerOf(project, key)
    if (provider === from) return { ok: true, unchanged: true, runner: from }
    if (provider !== 'dsh') {
      if (!this.driver.external) throw new Error('当前环境未开启外部执行')
      if (!this.driver.external.available()[provider]) throw new Error(`这台机器没装 ${RUNTIME_LABELS[provider]}`)
    }
    // The incoming executor is told what happened since it last had this task; one that never had it, since the task began.
    const last = project.events.findLast(e => e.type === 'thread.runner' && e.threadId === threadId && e.from === provider)
    const facts = this.handoffFacts(project, thread, last?.seq ?? 0, last ? last.facts?.workspace?.head ?? null : thread.workspace?.baseCommit ?? null)
    const running = this.driver.status(projectId, key) === 'running'
    this.commit(projectId, { type: 'thread.runner', threadId, provider, from, facts, by: { kind: 'human', id: 'owner' }, to: open ? [key] : [] }, 'handoff')
    return { ok: true, runner: provider, from, running }
  }

  /**
   * Pick the model one task runs on when DSH executes it; `model: "default"` goes back to the member's model.
   * No wake: DSH reads the selection before every step, so a running round switches on its next step.
   */
  /** Record the files a task's session read (new ones only), so the task board can show its inputs. */
  noteInputs({ projectId, threadId, paths }) {
    const thread = this.store.get(projectId)?.threads.get(threadId)
    if (thread === undefined) return
    const seen = new Set(thread.inputs ?? [])
    const fresh = [...new Set(paths ?? [])].filter(path => typeof path === 'string' && path && !seen.has(path)).slice(0, Math.max(0, THREAD_INPUTS_MAX - seen.size))
    if (fresh.length) this.store.append(projectId, { type: 'thread.read', threadId, paths: fresh })
  }

  async setTaskModel({ projectId, threadId, provider, model }) {
    const { thread } = this.ownedTask(projectId, threadId)
    let selection = null
    if (model !== 'default') {
      if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) throw new Error('要选一个模型')
      const catalog = await this.driver.modelCatalog()
      if (!catalog.groups?.some(g => g.id === provider && g.models.some(m => m.id === model))) throw new Error(`模型不可用：${provider}/${model}；请从当前模型列表选择`)
      selection = { provider, model }
    }
    const before = thread.modelSelection ?? null
    if (before?.provider === selection?.provider && before?.model === selection?.model) return { ok: true, unchanged: true, modelSelection: before }
    this.store.append(projectId, { type: 'thread.model', threadId, modelSelection: selection, by: { kind: 'human', id: 'owner' } })
    return { ok: true, modelSelection: selection }
  }

  /**
   * The owner takes the task: from now on nothing is dispatched to its executor, and what arrives waits in its inbox.
   * A turn already running is not cut off; `busy` says so, and it is the last one until the task is handed back.
   */
  holdTask({ projectId, threadId }) {
    const { project, thread, key, open } = this.ownedTask(projectId, threadId)
    if (!open) throw new Error('这个任务已经结束了，不用接手')
    const busy = this.driver.status(projectId, key) === 'running'
    if (thread.heldAt) return { ok: true, unchanged: true, busy }
    const directory = thread.workspace?.cwd ?? project.cwd
    this.store.append(projectId, { type: 'thread.held', threadId, head: directory ? workspaceChanges(directory, null)?.head ?? null : null, by: { kind: 'human', id: 'owner' } })
    return { ok: true, busy }
  }

  /** The owner hands the task back: its executor is woken with what was counted while the owner had it, and with whatever queued up. */
  releaseTask({ projectId, threadId }) {
    const { project, thread, key, open } = this.ownedTask(projectId, threadId)
    if (!thread.heldAt) return { ok: true, unchanged: true }
    const held = project.events.findLast(e => e.type === 'thread.held' && e.threadId === threadId)
    const facts = this.handoffFacts(project, thread, held?.seq ?? 0, held?.head ?? null)
    this.commit(projectId, { type: 'thread.released', threadId, runner: this.runnerOf(project, key), facts, by: { kind: 'human', id: 'owner' }, to: open ? [key] : [] }, 'handoff')
    return { ok: true }
  }

  ownerPost({ projectId, threadId, text: body, file_paths = [], typed }, context = {}) {
    const project = this.store.get(projectId)
    const content = text(body, '消息')
    // `typed`: the part of the text the owner typed themself. Only that part counts as their own words for memory
    // and the night review; a canned line or a handoff posted in their name carries none.
    const own = typeof typed === 'string' && typed.trim() !== '' && content.includes(typed.trim()) ? typed.trim() : undefined
    if (file_paths.length && !this.files) throw new Error('项目文件服务尚未就绪')
    const attachments = this.files?.attachments(projectId, file_paths) ?? []
    const thread = threadId ? project.threads.get(threadId) : undefined
    if (threadId && thread === undefined) throw new Error('没有这个线程')
    const mentions = this.store.mentions(project, content)
    // Chat goes to the coordinator, except a message that speaks only to Mira: that one is hers alone,
    // so the owner gets one answer instead of two. In a thread the assignee answers; the coordinator joins only when named.
    const onlyMira = mentions.length === 1 && mentions[0] === MIRA
    // bug ㉒ (cloud-run-14 #390): 「图片 evidence 这张我收了…@Mira 你那边还留着吗？」 spoke to Mira alone, so nobody relayed the
    // acceptance and the thread never reached done. A chat line that only @'s Mira still reaches the coordinator when it
    // carries an acceptance or a closing he must relay; the inbox item says Mira answers the memory part.
    const miraFirst = onlyMira && thread === undefined && (asksToClose(content) || asksToDrop(project, content))
    const retiredAssignee = thread && project.members.find(m => m.id === thread.assignee)?.active === false
    const to = retiredAssignee ? [COORDINATOR] : thread === undefined
      ? (onlyMira && !miraFirst ? [] : [COORDINATOR])
      : [workerKey(thread.id), ...(mentions.includes('coordinator') ? [COORDINATOR] : [])]
    // Mira is addressed, never a default recipient: she sees everything anyway.
    if (mentions.includes(MIRA)) to.push(MIRA)
    const event = this.commit(projectId, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId: thread?.id ?? null,
      author: { kind: 'human', id: 'owner' }, trust: 'principal', text: content, mentions, to, ...(miraFirst ? { miraFirst: true } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(context.handoff ? { handoff: context.handoff } : {}),
      ...(own ? { typed: own } : {}),
    }, mentions.length > 0 ? 'mention' : 'message')
    return { messageId: event.messageId }
  }

  /**
   * v4 harness (E2E #12): the owner typed into a task's DSH Session that no longer runs the task (it changed executor),
   * or stops running it at the next turn (a switch is waiting). Those words belong to whoever runs the task now: they
   * become the owner's message in the task, which wakes that executor. Null when the Session still runs the task, or the
   * task is over, so the caller lets the Session take the words as before.
   */
  redirectTyped({ sessionId, text: body }) {
    const current = this.store.bySession(sessionId)
    const at = current ?? this.store.formerSession(sessionId)
    if (at === undefined || !at.key.startsWith('w:')) return null
    const project = this.store.get(at.projectId), thread = project?.threads.get(at.key.slice(2))
    if (thread === undefined || thread.resolved || thread.state === 'done') return null
    if (current !== undefined && this.runnerOf(project, at.key) === (project.sessions.get(at.key)?.runtime ?? 'dsh')) return null
    return { projectId: project.id, threadId: thread.id, runner: this.runnerOf(project, at.key), ...this.ownerPost({ projectId: project.id, threadId: thread.id, text: body, typed: body }) }
  }

  /**
   * v4: the owner typed straight into a task's DSH Session. The worker already has those words as an ordinary turn,
   * so nobody is woken (`to: []`); the thread records them so acceptance and the timeline see the owner's own words.
   */
  mirrorNativeMessage({ projectId, threadId, text: body }) {
    const project = this.store.get(projectId)
    if (!project?.threads.has(threadId)) return null
    const content = text(body, '消息')
    const event = this.commit(projectId, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId,
      author: { kind: 'human', id: 'owner' }, trust: 'principal', text: content, mentions: [], to: [], native: true,
    }, 'message')
    return { messageId: event.messageId }
  }

  /**
   * v4: the owner typed straight into the project conversation, which is the project assistant's own DSH Session. The
   * assistant already has those words as an ordinary turn, so nobody is woken; the project chat records them so memory,
   * search and citations see the owner's own words.
   */
  mirrorNativeChat({ projectId, text: body }) {
    const content = text(body, '消息')
    const event = this.commit(projectId, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId: null,
      author: { kind: 'human', id: 'owner' }, trust: 'principal', text: content, mentions: [], to: [], native: true,
    }, 'message')
    return { messageId: event.messageId }
  }

  /**
   * v4: the project assistant answered in its own conversation, which is what the owner reads. The project chat records
   * the answer like a posted message, so memory and search see it; it is already shown, so nobody is woken.
   */
  mirrorAssistantText({ projectId, text: body }) {
    const project = this.store.get(projectId)
    const content = text(body, '消息')
    const event = this.commit(projectId, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId: null,
      author: { kind: 'assistant', id: COORDINATOR }, trust: 'relay', text: content,
      mentions: this.store.mentions(project, content), to: [], native: true,
    }, 'message')
    return { messageId: event.messageId }
  }

  /**
   * v4: personal Mira passes the owner's request on to one task. It is Mira's wording, so it is a relay, never the
   * owner's own words: it cannot serve as acceptance or as an answer to a decision.
   */
  miraRelay({ projectId, threadId, text: body, sourceRef }) {
    const project = this.store.get(projectId)
    const thread = project?.threads.get(threadId)
    if (thread === undefined) throw new Error('没有这个任务')
    if (thread.resolved || thread.state === 'done') throw new Error('这个任务已经完成或归档，后续请开新任务')
    const content = text(body, '消息')
    const event = this.commit(projectId, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId,
      author: { kind: 'assistant', id: MIRA }, trust: 'relay', text: content, mentions: [], to: [workerKey(threadId)],
      via: 'personal', ...(sourceRef ? { sourceRef } : {}),
    }, 'message')
    return { messageId: event.messageId }
  }

  answerDecision({ projectId, decisionId, chosen }) {
    const project = this.store.get(projectId)
    const decision = project.decisions.get(decisionId)
    if (decision === undefined) throw new Error('没有这个决策')
    if (decision.withdrawn) throw new Error(`这条拍板已作废${decision.withdrawReason ? `（${decision.withdrawReason}）` : ''}，不用再选了`)
    if (decision.chosen !== null) throw new Error('这个决策已经答复过了')
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= decision.options.length) throw new Error('选项无效')
    const answered = this.commit(projectId, {
      type: 'decision.answered', decisionId, chosen, by: { kind: 'human', id: 'owner' },
      threadId: decision.threadId, to: [workerKey(decision.threadId)],
    }, 'decision')
    // Mira's "等你拍板" cards about this are done with.
    this.retireCards(project, { threadId: decision.threadId, seqs: [decision.seq], before: answered.at, sinceAt: decision.at }, '已拍板')
    return { ok: true }
  }

  /**
   * Delete a project: it leaves every list and its Sessions become ordinary DSH Sessions. Nothing is erased, so
   * restoreProject brings it back whole. Refused while one of its Sessions is in the middle of a turn.
   */
  async deleteProject({ projectId }) {
    const project = this.store.get(projectId)
    const keys = [COORDINATOR, MIRA, ...project.threadOrder.map(workerKey)]
    if (keys.some(key => this.driver.status(projectId, key) === 'running')) throw new Error('这个项目还有会话在跑，等它停下或先停掉再删')
    // A native schedule would keep firing into a project that is gone, so its automations are paused first.
    for (const task of project.automations.values()) {
      if (task.enabled && !['deleted', 'paused', 'complete', 'missing'].includes(task.status)) await this.automations.pause({ projectId, automationId: task.id })
    }
    this.store.append(projectId, { type: 'project.deleted', by: { kind: 'human', id: 'owner' } })
    return { ok: true, projectId, name: project.name }
  }

  /** The owner picks the project's emoji and colour; the model never picks again for it. */
  setProjectIcon({ projectId, icon, color }) {
    const project = this.store.get(projectId)
    if (project.hub) throw new Error('个人助理没有项目图标')
    const picked = ownerIcon({ icon, color })
    this.store.append(project.id, { type: 'project.icon', ...picked, by: { kind: 'human', id: 'owner' } })
    return { ok: true, ...picked }
  }

  /** Put a deleted project back. Its automations stay paused: whether they run again is the owner's call. */
  restoreProject({ projectId }) {
    const project = this.store.trashed(projectId)
    this.store.append(projectId, { type: 'project.restored', by: { kind: 'human', id: 'owner' } })
    return { ok: true, projectId, name: project.name, pausedAutomations: [...project.automations.values()].filter(task => task.status === 'paused').length }
  }

  ownerUpdateThread({ projectId, threadId, resolved, state }) {
    const project = this.store.get(projectId)
    if (!project.threads.has(threadId)) throw new Error('没有这个线程')
    const thread = project.threads.get(threadId)
    if (project.members.find(m => m.id === thread.assignee)?.active === false && (
      (state !== undefined && !['done', 'failed'].includes(state)) || (resolved === false && thread.state !== 'done')
    )) throw new Error('这位成员已移出项目；需要继续工作请新开线程交给在职成员')
    const patch = {}
    if (typeof resolved === 'boolean') patch.resolved = resolved
    if (state !== undefined) {
      if (!THREAD_STATES.includes(state)) throw new Error('状态无效')
      patch.state = state
    }
    const accepting = patch.state === 'done' && thread.state !== 'done'
    const event = this.store.append(projectId, { type: 'thread.updated', threadId, patch, by: { kind: 'human', id: 'owner' } })
    if (patch.state === 'done' || patch.resolved === true) {
      const why = patch.resolved === true ? '线程已归档' : '线程已验收'
      this.retireDecisions(project, threadId, why, { kind: 'human', id: 'owner' })
      this.retireCards(project, { threadId, before: event.at }, why)
    }
    // Without GitLab, acceptance commits the task's worktree on its own branch (worktrees.js land).
    if (accepting) this.workspaces.land(project, thread)
    return { ok: true }
  }

  /** The owner asks Mira to tidy up now (or the host asks for the morning card). */
  miraRun({ projectId, reason = 'owner', note }) {
    const project = this.store.get(projectId)
    const why = reason === 'morning' ? 'morning' : 'owner'
    if (why === 'morning' && project.morningDay === dayKey(Date.now())) return { ok: true, skipped: 'today' }
    this.commit(projectId, {
      type: 'mira.requested', reason: why, note: typeof note === 'string' ? note.slice(0, 400) : undefined,
      by: { kind: why === 'morning' ? 'system' : 'human', id: why === 'morning' ? 'host' : 'owner' }, to: [MIRA],
    }, why)
    return { ok: true }
  }

  /** The owner acts on one of Mira's cards. Client-side actions are recorded too, so Mira learns what helps. */
  cardAction({ projectId, cardId, actionId }) {
    const project = this.store.get(projectId)
    const card = project.cards.get(cardId)
    if (card === undefined) throw new Error('没有这张卡')
    if (card.state !== 'open') throw new Error('这张卡已经处理过了')
    if (actionId === 'dismiss') {
      this.store.append(projectId, { type: 'card.dismissed', cardId, by: { kind: 'human', id: 'owner' } })
      return { ok: true }
    }
    const action = card.actions.find(a => a.id === actionId)
    if (action === undefined) throw new Error('这张卡没有这个动作')
    if (actionId === 'save_memory') {
      this.store.append(projectId, { type: 'memory.fact.added', text: text(action.text ?? card.body ?? card.title, 'text', 200), evidence: card.evidence, by: { kind: 'human', id: 'owner' } })
    }
    this.store.append(projectId, { type: 'card.acted', cardId, actionId, by: { kind: 'human', id: 'owner' } })
    return { ok: true, action }
  }

  memoryForget({ projectId, section, index }) {
    this.store.get(projectId)
    if (!MEMORY_SECTIONS.includes(section)) throw new Error('没有这一栏')
    if (!Number.isInteger(index) || index < 0) throw new Error('index 无效')
    this.store.append(projectId, { type: 'memory.item.removed', section, index, by: { kind: 'human', id: 'owner' } })
    return { ok: true }
  }

  // ------------------------------------------------------------- assistants

  author(project, key) {
    if (key === COORDINATOR) return { kind: 'assistant', id: 'coordinator' }
    if (key === MIRA) return { kind: 'assistant', id: MIRA }
    const binding = project.sessions.get(key)
    const thread = project.threads.get(key.slice(2))
    return { kind: 'assistant', id: binding?.assignee ?? thread?.assignee ?? 'worker' }
  }

  assistantPost(project, key, body, { file_paths = [] } = {}) {
    const content = text(body, 'text')
    if (file_paths.length && !this.files) throw new Error('项目文件服务尚未就绪')
    const attachments = this.files?.attachments(project.id, file_paths) ?? []
    // Mira watches; she speaks in the chat only to answer an @Mira the owner wrote and she has not answered yet.
    // cloud-run-06 #246: woken as an observer by a message to the coordinator, she repeated its answer in the chat
    // and added a decision nobody had asked for (bug 17). The prompt said so already; now the platform does.
    if (key === MIRA && !(project.miraAskSeq > project.miraReplySeq)) {
      throw new Error('没被点名：只有用户在消息里 @记忆助理、而你还没回过的时候才能在群聊说话。要记的用 memory_write，要提醒用户的用 card_propose，否则 no_reply。')
    }
    const threadId = key === COORDINATOR || key === MIRA ? null : key.slice(2)
    // cloud-run-25 #14 / #70, cloud-run-26 #15 / #110 / #416 / #478 (r29): 「开了两条：…→ @工程师（t_32a328bd56）」. The owner
    // sees thread titles and 「#1」「#2」, never t_ ids; a chat line carrying one is debris. Thread messages are left alone.
    // A task link [title](https://task.local/t_…) shows only its title; the id in its address is for the page, not for reading.
    if (threadId === null && /\bt_[0-9a-f]{8,12}\b/.test(content.replace(/\]\(https:\/\/task\.local\/t_[0-9a-f]{8,12}\)/g, ']()'))) throw new Error('群聊里别写线程 id（t_…）：用户看到的是线程标题和「#1」「#2」，id 他看不到也用不上。说标题，或写成链接 [任务标题](https://task.local/线程id)，这条重发一遍。')
    // cloud-run-27 #536 → #539 (r30): 「这件事归 Mira 记，她已被点名。」 — the owner had @'d Mira; woken for an acceptance that was
    // not there, the coordinator announced her instead of keeping quiet. The protocol has said so since r26; now the platform
    // does, and only while the owner's latest chat line did @Mira — 「要 Mira 答得 @Mira」 for a line that did not is his job.
    if (key === COORDINATOR && /归\s*(?:Mira|记忆助理)|(?:Mira|记忆助理|她)\s*(?:已(?:经)?)?被(?:点|@)名?|得\s*@\s*(?:Mira|记忆助理)|(?:让|由|交给)\s*(?:Mira|记忆助理)\s*(?:来)?(?:答|记|回)/i.test(content) && this.lastOwnerChatMentionedMira(project)) {
      throw new Error('用户已经 @记忆助理了，她会答；「这归记忆助理、她已被点名」这句多余，还会让用户以为她没收到。这条消息里有归你管的（验收要转达、新活要派）就只说那部分，没有就 no_reply。')
    }
    const event = this.commit(project.id, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId,
      author: this.author(project, key), trust: 'relay', text: content,
      ...(attachments.length ? { attachments } : {}),
      mentions: this.store.mentions(project, content), to: [],
    }, 'message')
    return event.messageId
  }

  react(project, key, messageId, emoji) {
    if (!project.messages.has(messageId)) throw new Error('没有这条消息')
    this.store.append(project.id, { type: 'reaction.added', messageId, emoji: text(emoji, 'emoji', 16), by: this.author(project, key) })
  }

  openThread(project, { title, brief, note, assignee, priority, cite_message_ids, related_thread_id }) {
    title = plain(title); brief = plain(brief); note = plain(note)
    if (related_thread_id !== undefined && !project.threads.has(related_thread_id)) throw new Error('来源线程必须属于当前项目')
    // An executor named on purpose (an older task's, or one the owner set up) still takes the task; otherwise the project's.
    const named = typeof assignee === 'string' && assignee.trim() !== ''
    const level = priority ?? 'P2'
    if (!PRIORITIES.includes(level)) throw new Error('priority 只能是 P0 到 P3')
    let member
    if (named) {
      member = this.store.memberByName(project, text(assignee, 'assignee', 40))
      if (member === undefined || member.role !== 'worker') throw new Error('assignee 一般不填：任务会交给项目的执行者。填了就必须是已有执行者的名字')
    } else {
      text(title, 'title', 80); text(brief, 'brief')
      member = this.executorOf(project)
    }
    const threadId = this.store.newThreadId()
    const cardMessageId = this.store.newMessageId()
    const cited = this.cites(project, cite_message_ids)
    // r23 (cloud-run-20 #7 「@工程师 @工程师 接口这活是你的…」): the chat line already opens with the assignee's @; a note that
    // repeats it (or the id) loses that prefix once.
    const cleanNote = typeof note === 'string'
      ? note.trim().replace(new RegExp(`^(?:@${[member.name, member.id].filter(Boolean).map(n => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|@')})[\\s，,：:、]*`), '').trim()
      : ''
    const name = text(title, 'title', 80)
    this.commit(project.id, {
      type: 'thread.opened', threadId, title: name, brief: text(brief, 'brief'), note: cleanNote,
      assignee: member.id, priority: level, openedBy: { kind: 'assistant', id: 'coordinator' }, cited, cardMessageId,
      repository: project.repository ?? null, repositoryBound: true,
      ...(related_thread_id ? { relatedThreadId: related_thread_id } : {}),
      to: [workerKey(threadId)],
    }, 'spawn')
    this.store.append(project.id, {
      type: 'message.posted', messageId: cardMessageId, threadId: null,
      author: { kind: 'assistant', id: 'coordinator' }, trust: 'relay',
      text: named ? (cleanNote ? `@${member.name} ${cleanNote}` : `开了线程，交给 @${member.name}。`) : (cleanNote || '开了任务。'),
      mentions: named ? [member.id] : [], card: { kind: 'thread', threadId }, to: [],
    })
    return { threadId, assignee: member.name }
  }

  updateCard(project, key, args) {
    const threadId = key.slice(2)
    const thread = project.threads.get(threadId)
    if (thread === undefined) throw new Error('只有线程里的执行者能更新卡片')
    const patch = {}
    if (args.title !== undefined) patch.title = text(args.title, 'title', 80)
    if (args.summary !== undefined) patch.summary = String(args.summary).slice(0, 280)
    if (args.priority !== undefined) {
      if (!PRIORITIES.includes(args.priority)) throw new Error('priority 只能是 P0 到 P3')
      patch.priority = args.priority
    }
    if (args.checklist !== undefined) {
      if (!Array.isArray(args.checklist) || args.checklist.length > 12) throw new Error('checklist 最多 12 项')
      patch.checklist = args.checklist.map(item => ({ text: text(item?.text, 'checklist.text', 120), done: item?.done === true }))
    }
    if (args.state !== undefined) {
      if (!THREAD_STATES.includes(args.state)) throw new Error(`state 只能是 ${THREAD_STATES.join(' / ')}`)
      patch.state = args.state
    }
    // While a question waits for the owner the thread reads 「等你」; a worker busy on other parts does not change
    // that (cloud-run-04 #130 / #153 / #167 flipped a thread with two open questions back to working; bug 16).
    // The dropped field stays on the record as `ignored`, so a run's event log shows the guard fired; cloud-run-05
    // left no trace of it and the behaviour had to be inferred from the state never flipping (r9).
    // Delivering is held the same way (bug 18): cloud-run-09 #102 set review_ready with the pagination question still
    // open, and the platform retired the question as 「线程已交付待验收」 — the owner never got to answer it, and the
    // engineer went on believing the card was still up (#154, #162). A worker who no longer needs the answer
    // withdraws the question first (withdraw_decision, with the reason), then delivers. done and failed still retire
    // what waits: the thread is over. `wanted` keeps the dropped state on the record for the timeline and the inbox.
    const ignored = []
    let wanted
    if ((patch.state === 'working' || patch.state === 'review_ready') && thread.state === 'blocked' && this.store.pendingDecisions(project, threadId).length > 0) {
      wanted = patch.state
      delete patch.state
      ignored.push('state')
    }
    // A closed thread stays closed (cloud-run-23 #438): the coordinator relayed 「加 screenshot 字段…置回待验收」 into the
    // thread the owner had accepted at #401, the engineer set working → review_ready → done again, and the history read
    // one thread accepted twice while Mira's memory and the retired cards said it was over. Follow-up work on an accepted
    // or archived thread is a new thread for the same assignee; the dropped state stays on the record as `ignored` +
    // `closed` so the timeline, the inbox and the worker's tool result all say so. failed is not closed: a retry goes
    // back to work (r26).
    let closed = false
    if (patch.state !== undefined && patch.state !== thread.state && (thread.state === 'done' || thread.resolved === true)) {
      wanted = patch.state
      delete patch.state
      ignored.push('state')
      closed = true
    }
    if (project.gitlab && patch.state === 'done' && thread.state !== 'done') {
      const evidence = this.acceptanceEvidence(project, thread, args.acceptance_message_id)
      const approved = thread.gitlab?.approvedSha && thread.gitlab.approvedSha === thread.gitlab.sha
      if (!evidence && !approved) throw new Error('只有用户针对本次交付明确验收后才能合并；请引用用户验收原话，或由用户点击「验收通过」')
      if (!this.gitlabWorkflow) throw new Error('GitLab 验收服务尚未就绪')
      const acceptance = evidence ? this.gitlabWorkflow.acceptMessage(project.id, thread.id, evidence.id) : this.gitlabWorkflow.accept(project.id, thread.id, thread.gitlab.sha)
      return acceptance.then(() => {
        const remaining = { ...patch }; delete remaining.state
        const result = this.updateCard(project, key, remaining)
        return { ...result, state: 'done' }
      })
    }
    // The same held request again is the same fact, not a second one: cloud-run-21 #161 → #176 sent `state: working`
    // twice while one question waited, the timeline said 「保持等你」 twice and Mira read it as 「线程改回进行中」. The
    // event keeps `repeat`, and the timeline and the inboxes show the first row only. A state that moved, or a question
    // that was answered / withdrawn / asked in between, makes the next held request a fresh row (r24).
    let repeat = false
    if (ignored.length > 0) {
      for (let i = project.events.length - 1; i >= 0; i--) {
        const e = project.events[i]
        if (e.threadId !== threadId) continue
        if (typeof e.type === 'string' && e.type.startsWith('decision.')) break
        if (e.type !== 'thread.updated') continue
        if (e.patch?.state !== undefined) break
        if (Array.isArray(e.ignored) && e.ignored.includes('state')) { repeat = e.wanted === wanted; break }
      }
    }
    if (Object.keys(patch).length === 0 && ignored.length === 0) return patch
    const changedState = patch.state !== undefined && patch.state !== thread.state
    const event = this.commit(project.id, {
      type: 'thread.updated', threadId, patch, ...(ignored.length ? { ignored, wanted, ...(repeat ? { repeat: true } : {}), ...(closed ? { closed: true } : {}) } : {}), by: this.author(project, key),
      to: changedState && NOTIFY_COORDINATOR.has(patch.state) ? [COORDINATOR] : [],
    }, 'thread_state')
    // Delivered, finished or failed: nothing in this thread waits for the owner any more, and Mira's
    // cards about its earlier phase ("等你拍板", "卡住了") are out of date.
    if (changedState && RETIRES_DECISIONS[patch.state] !== undefined) {
      this.retireDecisions(project, threadId, RETIRES_DECISIONS[patch.state], this.author(project, key))
      // A delivery retires the "等交付" cards from the phase before it. When a delivered thread went back to work
      // (a decision, a rework) and delivers again, only cards from that later phase go; the review card written
      // while it first sat in review_ready still stands (cloud-run-01 #253 retired one and Mira had to re-propose).
      const sinceAt = patch.state === 'review_ready' ? (thread.leftReviewAt ?? 0) : 0
      this.retireCards(project, { threadId, before: event.at, sinceAt }, RETIRES_DECISIONS[patch.state])
    }
    // The owner said 验收通过 in the task conversation and the executor closed it: land it as the owner's button does.
    if (changedState && patch.state === 'done') this.workspaces.land(project, thread)
    return patch
  }

  /** A receipt must come from the owner after this delivery and identify this thread. */
  acceptanceEvidence(project, thread, messageId) {
    const delivered = project.events.filter(e => e.threadId === thread.id && (
      (e.type === 'thread.updated' && e.patch?.state === 'review_ready') || e.type === 'decision.requested' || e.type === 'mr.publish.started'
    )).at(-1)?.seq ?? Infinity
    const messages = [...project.messages.values()].filter(m => m.author?.kind === 'human' && m.seq > delivered && (!messageId || m.id === messageId)).reverse()
    for (const message of messages) {
      if (message.threadId !== null && message.threadId !== thread.id) continue
      if (/^\s*(?:如果|假如|假设|要是|等到)/.test(message.text)) continue
      if (message.text.length > 1000 || /```|别把|不要把|不代表|并非|没说|未说|引用|示例|有人说|声称/.test(message.text)) continue
      for (const match of message.text.matchAll(/[^，,。.!！;；\n]+/g)) {
        let clause = match[0].trim()
        const quoted = /^[「『“"](.+?)[」』”"]\s*/.exec(clause)
        if (quoted) { if (quoted[1] !== thread.title) continue; clause = clause.slice(quoted[0].length) }
        else if (clause.startsWith(thread.title)) clause = clause.slice(thread.title.length).trim()
        if (!/^(?:(?:这|那)(?:张|条|个)(?:卡片|线程|任务)?)?我?(?:已经|刚才)?(?:验收通过(?:了)?|收了|验过了)$/.test(clause)) continue
        const before = message.text.slice(0, match.index + match[0].length)
        const named = [...project.threads.values()].map(t => ({ thread: t, position: before.lastIndexOf(t.title) })).filter(x => x.position >= 0).sort((a, b) => b.position - a.position)
        if (named.length && named[0].thread.id !== thread.id) continue
        if (message.threadId === thread.id) return message
        if (named[0]?.thread.id === thread.id && [...project.threads.values()].filter(t => t.title === thread.title && !t.resolved && t.state === 'review_ready').length === 1) return message
      }
    }
    return null
  }

  requestDecision(project, key, { question, options, recommended }) {
    const threadId = key.slice(2)
    const thread = project.threads.get(threadId)
    if (thread === undefined) throw new Error('只有线程里的执行者能发起决策')
    const wasReview = thread.state === 'review_ready'
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) throw new Error('options 需要 2 到 4 个')
    const clean = options.map(option => ({
      label: text(option?.label, 'options.label', 40),
      consequence: typeof option?.consequence === 'string' ? option.consequence.slice(0, 200) : '',
    }))
    const best = Number.isInteger(recommended) && recommended >= 0 && recommended < clean.length ? recommended : 0
    const decisionId = this.store.newDecisionId()
    const author = this.author(project, key)
    const messageId = this.store.newMessageId()
    const ask = text(question, 'question', 200)
    // A thread may hold several open questions: cloud-run-03 lost the owner's unanswered pagination card when the
    // engineer asked about time formats next (bug 15). Only the same question asked again replaces its older copy;
    // a question that no longer applies is the worker's to withdraw.
    const waiting = this.store.pendingDecisions(project, threadId)
    const twins = waiting.filter(d => sameQuestion(d.question, ask))
    for (const twin of twins) this.retireOne(project, twin, '被新的拍板替换', author)
    const replaced = twins.map(d => d.id)
    const pending = waiting.filter(d => !twins.includes(d)).map(d => d.id)
    this.store.append(project.id, {
      type: 'message.posted', messageId, threadId, author, trust: 'relay', text: ask,
      mentions: [], card: { kind: 'decision', decisionId }, to: [],
    })
    this.store.append(project.id, {
      type: 'decision.requested', decisionId, threadId, question: ask, options: clean, recommended: best, messageId, by: author,
    })
    // Mirror the card into the project chat so the owner sees it where they are.
    this.store.append(project.id, {
      type: 'message.posted', messageId: this.store.newMessageId(), threadId: null, author, trust: 'relay',
      text: ask, mentions: [], card: { kind: 'decision', decisionId, threadId }, to: [],
    })
    // cloud-run-28 R6 → R7 (r31): 「healthz 待验收」 stayed open after the engineer, asked for two more decisions, pulled the
    // delivered thread back to 「等你」 — and its summary kept saying 待验收. Nothing waits to be accepted while a question is
    // open: the review card goes (the other side of bug ⑬), and the worker is told to rewrite the summary.
    if (wasReview) this.retireCards(project, { threadId, kinds: ['next_step'] }, '线程回到「等你」：执行者又发了拍板')
    const hint = wasReview ? '线程从「待验收」回到了「等你」，记忆助理的「待验收」卡平台已撤；摘要还写着「待验收」的话，update_card 把它改成「在等你选 X；交付的东西原样放着」' : ''
    return { decisionId, replaced, pending, wasReview, hint }
  }

  /** A worker takes back a question that no longer applies: the plan changed, the options are gone. */
  withdrawDecision(project, key, { decision_id, reason }) {
    const threadId = key.slice(2)
    if (!project.threads.has(threadId)) throw new Error('只有线程里的执行者能作废拍板')
    const decision = project.decisions.get(decision_id)
    if (decision === undefined) throw new Error('没有这个决策')
    if (decision.threadId !== threadId) throw new Error('只能作废自己线程里的拍板')
    if (decision.withdrawn) throw new Error('这条拍板已经作废了')
    if (decision.chosen !== null) throw new Error('用户已经选过了，作废不了；按用户的选择继续，或者发一张新的拍板')
    this.retireOne(project, decision, text(reason, 'reason', 200), this.author(project, key))
    return decision.id
  }

  /** Withdraw every open decision of a thread; returns their ids. */
  retireDecisions(project, threadId, reason, by) {
    const open = this.store.pendingDecisions(project, threadId)
    for (const decision of open) this.retireOne(project, decision, reason, by)
    return open.map(d => d.id)
  }

  retireOne(project, decision, reason, by) {
    const event = this.store.append(project.id, {
      type: 'decision.withdrawn', decisionId: decision.id, threadId: decision.threadId, reason, by,
    })
    this.retireCards(project, { threadId: decision.threadId, seqs: [decision.seq], before: event.at, sinceAt: decision.at }, `拍板已作废：${reason}`)
  }

  /**
   * Close Mira's open cards that a later fact made moot: cards about `threadId` created between `sinceAt` and
   * `before`, or cards whose newest evidence is one of `seqs` (next_step / reminder / open_loop only; recaps and
   * captures stay). Two run-07/08 lessons narrow it: a card that only mentions one of `seqs` among older evidence is
   * about something later and stays (run-07: a designer card cited the engineer's decision); and when a decision is
   * settled, a card written before that decision existed (run-08: 「验收卡片流样式」 from before the 圆角 question)
   * is about the delivery, not the decision, and stays. Thread done/resolved passes no `sinceAt`: everything goes.
   * The owner sees them as 已过时 with the note; Mira sees nothing to withdraw by hand.
   */
  retireCards(project, { threadId, seqs = [], before = Infinity, sinceAt = 0, kinds }, note) {
    for (const card of this.store.openCards(project)) {
      if (!STALE_KINDS.has(card.kind) || (kinds !== undefined && !kinds.includes(card.kind))) continue
      const cites = seqs.includes(Math.max(...card.evidence))
      const about = threadId !== undefined && card.threadId === threadId && card.at >= sinceAt && card.at <= before
      if (!cites && !about) continue
      this.store.append(project.id, { type: 'card.withdrawn', cardId: card.id, reason: 'stale', note: String(note).slice(0, 120), by: { kind: 'system', id: 'host' } })
    }
  }

  relay(project, key, { toKey, text: body, cite_message_ids }) {
    const from = this.author(project, key)
    // cloud-run-27 #276 (r30): Mira relayed the owner's chat question to the coordinator — who had read it himself — and the
    // relay went out as from_thread="ra" (her key sliced like a worker's). Mira watches and tells the owner; she asks nobody.
    if (key === MIRA) throw new Error('记忆助理不转话：用户在群聊里说的，协调员已经看到了，转一遍他会答两遍；执行者线程里的话他也能自己读。你看到的没收尾的事递 open_loop 卡（动作带 reply，text 写一句用户能直接发进群聊的「@协调员 新开一条给工程师：…」），要不要开新线程由用户定。')
    const fromThreadId = key.startsWith('w:') ? key.slice(2) : undefined
    const toThreadId = toKey === COORDINATOR ? undefined : toKey.slice(2)
    if (toThreadId !== undefined && !project.threads.has(toThreadId)) throw new Error('没有这个线程')
    if (toThreadId !== undefined) {
      // cloud-run-23 #431 (r26): a relay into an accepted thread reopened it. Closed is closed; the follow-up is a new thread.
      const target = project.threads.get(toThreadId)
      if (project.members.find(m => m.id === target.assignee)?.active === false) throw new Error('这位成员已移出项目，这条话没有转发；请新开线程交给在职成员')
      if (target.state === 'done' || target.resolved === true) {
        const name = target.title.slice(0, 24)
        throw new Error(`线程「${name}」${target.resolved === true ? '已归档' : '已经完成（用户验收过）'}，关了的线程不重开，这条话没转。用户要在它基础上改或补：open_thread 新开一条给同一负责人（note 写明是「${name}」的后续，cite 用户原话 id）；只是问它的情况：read_thread 自己看，在群聊里答。`)
      }
    }
    this.commit(project.id, {
      type: 'relay.sent', relayId: this.store.newMessageId(), from, fromThreadId, toThreadId,
      text: text(body, 'text'), cited: this.cites(project, cite_message_ids), to: [toKey],
    }, 'relay')
  }

  // ------------------------------------------------------------- Mira

  writeMemory(project, key, sections) {
    if (key !== MIRA) throw new Error('只有记忆助理能写记忆')
    const memory = {}
    const aliases = { open_loops: 'openLoops' }
    for (const section of MEMORY_SECTIONS) {
      const raw = sections[section] ?? sections[Object.keys(aliases).find(a => aliases[a] === section) ?? '']
      if (raw === undefined) { memory[section] = project.memory[section]; continue }
      if (!Array.isArray(raw) || raw.length > 12) throw new Error(`${section} 要是数组，最多 12 条`)
      memory[section] = raw.map(item => ({
        text: text(typeof item === 'string' ? item : item?.text, `${section}.text`, 120),
        evidence: seqList(typeof item === 'string' ? [] : item?.evidence_seq ?? item?.evidence, `${section}.evidence_seq`),
      }))
    }
    const missing = MEMORY_SECTIONS.flatMap(s => memory[s].filter(i => i.evidence.length === 0).map(i => i.text))
    if (missing.length > 0) throw new Error(`这些条目没有 evidence_seq，没有证据的不写：${missing.slice(0, 3).join('；')}`)
    const events = new Map(project.events.map(event => [event.seq, event]))
    for (const section of MEMORY_SECTIONS) for (const item of memory[section]) {
      // Keep unchanged legacy entries readable; do not block an unrelated cleanup or silently delete history.
      if (project.memory[section].some(old => old.text === item.text && JSON.stringify(old.evidence) === JSON.stringify(item.evidence))) continue
      const sources = item.evidence.map(seq => events.get(seq))
      if (sources.some(source => source === undefined)) throw new Error(`记忆「${item.text.slice(0, 30)}」引用了本项目不存在的 evidence_seq，请核对实际动态再写`)
      if (section === 'facts' && !sources.some(source => FACT_EVIDENCE.has(source.type)
        || (source.type === 'thread.updated' && typeof source.patch?.summary === 'string' && source.patch.summary.trim())
        || (source.type === 'card.acted' && source.actionId === 'save_memory'))) {
        throw new Error(`长期事实「${item.text.slice(0, 30)}」不能只凭状态或会话记账事件写入；请引用用户原话、已选决定、项目说明或真实交付陈述。平台规则和推测不要写入 facts`)
      }
    }
    // r31: the event records that the loose-end reminder fired (`hinted`), so QA can see it without the tool's return text.
    const loose = this.looseEnds(project, memory.openLoops)
    this.store.append(project.id, { type: 'memory.updated', memory, by: this.author(project, key), ...(loose.length ? { hinted: loose.length } : {}) })
    const summary = MEMORY_SECTIONS.map(s => `${s} ${memory[s].length}`).join('，')
    return loose.length === 0 ? summary : `${summary}。提醒：${loose.join('；')}`
  }

  /**
   * open_loops whose evidence sits in a thread accepted since, with no open_loop card on that thread and no sign the owner
   * deferred the thing himself. cloud-run-27 #412 (r30): Mira wrote 「翻页插卡三选一取舍待定，接口线程已关，要做得新开一条」 into
   * open_loops and went quiet — the owner never sees a memory row. Named back to her on the memory_write result, in the same turn.
   */
  looseEnds(project, loops) {
    const out = []
    for (const loop of loops) {
      if (/你说|用户(?:自己)?说|他说|先不选|下一版|以后再|之后再|暂缓|不做了|搁置/.test(loop.text)) continue
      const threads = new Set(loop.evidence.map((seq) => {
        const e = project.events.find(x => x.seq === seq)
        return e?.threadId ?? e?.toThreadId ?? e?.fromThreadId ?? undefined
      }).filter(id => typeof id === 'string'))
      for (const threadId of threads) {
        const thread = project.threads.get(threadId)
        if (thread === undefined || thread.state !== 'done' || thread.resolved === true) continue
        const carded = project.cardOrder.map(id => project.cards.get(id)).some(c => c.kind === 'open_loop' && c.threadId === threadId && !['stale', 'withdrawn', 'expired'].includes(c.state))
        if (carded) continue
        out.push(`「${loop.text.slice(0, 30)}」的依据在已关单的线程「${thread.title.slice(0, 24)}」里：没人在做、也没有拍板卡等用户，而用户看不到记忆里的这一行——这是没收尾的事，这一轮就递一张 open_loop 卡（thread_id 挂这条线程，动作带 reply，text 写一句用户能直接发进群聊的「@协调员 新开一条给工程师：…」）。用户自己说「先不选」「下一版再」的不算，那是他定的`)
      }
    }
    return out
  }

  /** Whether the owner's latest chat line @'d Mira — the case where the coordinator must not point at her (r30). */
  lastOwnerChatMentionedMira(project) {
    for (let i = project.events.length - 1; i >= 0; i--) {
      const e = project.events[i]
      if (e.type === 'message.posted' && e.author?.kind === 'human' && !e.threadId) return Array.isArray(e.mentions) && e.mentions.includes(MIRA)
    }
    return false
  }

  /**
   * Why a card would be stale the moment it lands, or undefined. Mira acts on an inbox snapshot; by the time she
   * proposes, the decision she cites may be answered or withdrawn, or the thread accepted — the same facts that
   * retireCards() closes cards over a moment later. Refusing up front keeps a “等你拍板” for a settled decision out
   * of the owner's stack, and the error tells Mira what happened instead of leaving her to guess. Recaps and
   * captures describe the past, so they may cite anything.
   */
  mootCard(project, { kind, threadId, evidence, title, body }) {
    if (!STALE_KINDS.has(kind)) return undefined
    // The newest fact the card points at is a question that has since been settled: the card comes from a stale
    // snapshot. A card that also cites something newer (the delivery, the answer) is about that newer thing.
    const last = Math.max(...evidence)
    // The question is on the record three times: the thread message, the decision event, the chat mirror. cloud-run-24 #54
    // cited the mirror (#42) of a question answered at #47 and slipped past this check (r27).
    const cited = project.events.find(e => e.seq === last)
    const decision = [...project.decisions.values()].find(d => d.seq === last)
      ?? (cited?.type === 'message.posted' && cited.card?.kind === 'decision' ? project.decisions.get(cited.card.decisionId) : undefined)
    if (decision !== undefined) {
      const question = decision.question.slice(0, 40)
      if (decision.withdrawn) return `不用递：这张卡最新的依据 ${decision.seq} 是拍板「${question}」，它已作废（${decision.withdrawReason || '问题已经不成立'}）。重新 inbox_read 看现在的状态；要记就更新 memory。`
      if (decision.chosen !== null) return `不用递：这张卡最新的依据 ${decision.seq} 是拍板「${question}」，用户已经选了「${decision.options[decision.chosen]?.label ?? decision.chosen}」。要记就写进 memory 的 decisions。`
    }
    if (threadId !== undefined) {
      const thread = project.threads.get(threadId)
      if (thread?.resolved === true) return `不用递：线程「${thread.title.slice(0, 24)}」已经归档，关于它的 ${kind} 卡会立刻过时。`
      // cloud-run-25 #354 (r28): the engineer wrote 「错误码格式等用户之后定」, never put it to the owner, delivered, and the
      // thread was accepted — the loose end a closed thread leaves is exactly an open_loop, and nothing further happens
      // to a done thread that could make the card stale (archiving retires it). next_step / reminder about a done thread
      // still have nothing left for the owner to do.
      if (thread?.state === 'done' && kind !== 'open_loop') return `不用递：线程「${thread.title.slice(0, 24)}」已经完成，关于它的 ${kind} 卡会立刻过时${kind === 'next_step' ? '；它留下的尾巴（没定的事、没发的拍板）用 open_loop 递，动作带 reply 请协调员新开一条' : ''}。`
      // cloud-run-22 #44: 「接口可验收了 · 工程师已按你选的页码分页交付」 went up while the engineer was still reworking after
      // the answer (thread working); the platform retired it four seconds later as 「线程已交付待验收」. A delivery the owner
      // can act on exists once the thread waits on them (r25).
      if (kind === 'next_step' && thread?.state === 'working' && /验收|交付|做完|写完|可以看/.test(`${title ?? ''}${body ?? ''}`)) {
        return `不用递：线程「${thread.title.slice(0, 24)}」还在「进行中」，没到待验收——执行者置 review_ready 时你会收到通知，到时再递验收卡。`
      }
    }
    return undefined
  }

  proposeCard(project, key, { kind, title, body, thread_id, evidence_seq, actions, confidence }) {
    if (key !== MIRA) throw new Error('只有记忆助理能递卡')
    if (!CARD_KINDS.includes(kind)) throw new Error(`kind 只能是 ${CARD_KINDS.join(' / ')}`)
    const threadId = typeof thread_id === 'string' && thread_id ? thread_id : undefined
    if (threadId !== undefined && !project.threads.has(threadId)) throw new Error('没有这个线程')
    const evidence = seqList(evidence_seq, 'evidence_seq')
    if (evidence.length === 0 && kind !== 'morning') throw new Error('evidence_seq 不能为空：卡片里的事实要能指出来自哪条动态')
    // cloud-run-24 #146 / #297 (r27): 「序号（seq）60 卡片流样式…」 went to the owner. seq is the platform's bookkeeping, not
    // something the owner can see or look up; the citation belongs in evidence_seq, the body names the thread and the speaker.
    if (/\bseq\b/i.test(`${title ?? ''}${body ?? ''}`)) throw new Error('标题和正文里别写 seq：用户看不到事件序号，也查不到。出处放 evidence_seq，正文说清是哪条线程、谁说的。')
    const moot = this.mootCard(project, { kind, threadId, evidence, title, body })
    if (moot !== undefined) throw new Error(moot)
    const clean = (Array.isArray(actions) ? actions : []).slice(0, 3).map((action) => {
      const id = typeof action === 'string' ? action : action?.id
      if (!CARD_ACTIONS.includes(id)) throw new Error(`actions 只能是 ${CARD_ACTIONS.join(' / ')}`)
      if (id === 'open_thread' && threadId === undefined) throw new Error('open_thread 需要 thread_id')
      const extra = typeof action === 'object' && typeof action?.text === 'string' ? { text: action.text.slice(0, 400) } : {}
      if ((id === 'reply' || id === 'copy_text') && extra.text === undefined) throw new Error(`${id} 需要 text`)
      return { id, ...ACTION_LABEL[id], ...extra }
    }).filter((action, i, all) => all.findIndex(a => a.id === action.id) === i) // one button per action: two “回一句” read as a glitch
    if (threadId !== undefined && !clean.some(a => a.id === 'open_thread')) clean.unshift({ id: 'open_thread', ...ACTION_LABEL.open_thread })
    const today = dayKey(Date.now())
    const cards = project.cardOrder.map(id => project.cards.get(id))
    // Cards the platform retired as stale, or Mira withdrew herself, give their slot back (run-08: three cards by
    // 18:00, one of them retired by a withdrawn decision, and Mira had no budget left to put the review card back).
    const todays = cards.filter(c => c.kind !== 'morning' && dayKey(c.at) === today && c.state !== 'stale' && c.state !== 'withdrawn')
    if (kind !== 'morning' && todays.length >= DAILY_CARDS) throw new Error(`今天已经发了 ${DAILY_CARDS} 张卡，把最重要的留到明天；可以用 card_withdraw 撤回一张再发`)
    const open = cards.filter(c => c.state === 'open')
    const twin = open.find(c => c.kind === kind && (threadId !== undefined ? c.threadId === threadId : c.title === title))
    const cardId = this.store.newCardId()
    const level = typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : undefined
    this.store.append(project.id, {
      type: 'card.proposed', cardId, kind, title: text(title, 'title', 24), body: typeof body === 'string' ? body.slice(0, 160) : '',
      threadId, actions: clean, evidence, confidence: level, by: this.author(project, key),
      ...(twin !== undefined ? { supersedes: twin.id } : {}),
    })
    // Keep the stack short: the oldest open card beyond the cap expires.
    const stillOpen = project.cardOrder.map(id => project.cards.get(id)).filter(c => c.state === 'open')
    for (const old of stillOpen.slice(0, Math.max(0, stillOpen.length - MAX_OPEN_CARDS))) {
      this.store.append(project.id, { type: 'card.withdrawn', cardId: old.id, reason: 'expired', by: { kind: 'system', id: 'host' } })
    }
    return { cardId, superseded: twin?.id }
  }

  withdrawCard(project, key, cardId, reason) {
    if (key !== MIRA) throw new Error('只有记忆助理能撤卡')
    const card = project.cards.get(cardId)
    if (card === undefined) throw new Error('没有这张卡')
    if (card.state !== 'open') throw new Error('这张卡已经不在了')
    this.store.append(project.id, { type: 'card.withdrawn', cardId, reason: typeof reason === 'string' ? reason.slice(0, 200) : '', by: this.author(project, key) })
  }
}

/** The same question asked twice, give or take punctuation and spaces. */
function sameQuestion(a, b) {
  const norm = q => String(q).toLowerCase().replace(/[\s，。？?！!、：:；;「」『』“”"'（）()【】\[\]]/g, '')
  return norm(a) === norm(b)
}
