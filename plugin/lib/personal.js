/** Owner's personal conversation, bounded source retrieval and recoverable project handoff. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { HUB_ID } from './hub.js'
import { MIRA, STARTER_MEMBERS } from './store.js'
import { STATE_LABEL } from './protocol.js'
import { PersonalSearchIndex, searchText } from './personal-search-index.js'
import { findAssistant, modelLabel, pickModel } from './members.js'
import { landingNote } from './worktrees.js'
import { feishuConversations, own as ownWords, speakerOf } from './followups.js'

const required = (value, name, limit = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || !value.isWellFormed()) throw new Error(`${name} 无效`)
  return value.trim()
}
const requestKey = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:._-]{8,128}$/.test(value)) throw new Error('requestId 需要稳定的8–128位标识')
  return value
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const time = value => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('时间必须是带时区的ISO时间戳')
  return Date.parse(value)
}

export class PersonalMira {
  constructor(hubStore, driver, projects, projectActions, { observations, connectors, retention, gitlab } = {}) {
    this.hubStore = hubStore;this.driver = driver;this.projects = projects;this.projectActions = projectActions;this.gitlab = gitlab
    this.observations = observations;this.connectors = connectors
    if (this.hub.personalVersion !== 2) hubStore.append(HUB_ID, { type: 'personal.protocol', version: 2 })
    this.index = new PersonalSearchIndex(this)
    this.retention = retention;retention?.attach(this)
  }

  get hub() { return this.hubStore.get(HUB_ID) }
  close() { this.index.close();this.retention?.detach(this) }

  searchable(project, event) {
    if (event.sourceExpired || project.hub && this.retention?.isExpired(event)) return false
    if (event.type === 'connector.record' && this.connectors && !this.connectors.isCurrent(event)) return false
    if (event.type === 'observation.summary' && this.observations?.summaries.get(event.windowId)?.seq !== event.seq) return false
    if (event.type === 'pc.activity' && (project.activities?.get(event.windowKey)?.seq !== event.seq || !event.activities.length)) return false
    return true
  }

  /**
   * `context`: what came with the words but is not theirs (截图来问: the screenshot's text, app and window). The assistant
   * reads it as a reminder beside the message; it is never shown as the owner's words and never becomes memory.
   */
  post({ text, requestId, typed, context, via }) {
    const body = required(text, '消息'), key = requestKey(requestId)
    const extra = typeof context === 'string' && context.trim() !== '' ? context.trim().slice(0, 8000) : undefined
    // `typed`: the part of `text` the owner typed themself (the page may add a prefix); only that part can become memory.
    const own = typeof typed === 'string' && typed.trim() !== '' && body.includes(typed.trim()) ? typed.trim() : undefined
    let event = this.hub.events.find(e => e.type === 'message.posted' && e.personalRequestId === key)
    if (event && event.text !== body) throw new Error('同一请求的重试内容不一致')
    if (!event) event = this.hubStore.append(HUB_ID, { type: 'message.posted', messageId: this.hubStore.newMessageId(),
      personalRequestId: key, threadId: null, author: { kind: 'human', id: 'owner' }, trust: 'principal', text: body, mentions: [MIRA], to: [MIRA], ...(own ? { typed: own } : {}),
      ...(extra ? { context: extra } : {}), ...(typeof via === 'string' && /^[a-z-]{1,20}$/.test(via) ? { via } : {}) })
    this.driver.deliver(event, 'conversation')
    return { ok: true, messageId: event.messageId }
  }

  retry({ messageId, requestId }) {
    const key = requestKey(requestId)
    let event = this.hub.events.find(e => e.type === 'mira.requested' && e.personalRetryId === key)
    if (event && event.replyTo !== messageId) throw new Error('同一请求的重试内容不一致')
    if (!event) {
      if (this.retryMessageId() !== messageId) throw new Error('当前没有可重试的个人消息')
      event = this.hubStore.append(HUB_ID, { type: 'mira.requested', reason: 'conversation', replyTo: messageId,
        personalRetryId: key, to: [MIRA] })
    }
    this.driver.deliver(event, 'conversation')
    return { ok: true, messageId, retrySeq: event.seq }
  }

  retryMessageId() {
    if (this.driver.status(HUB_ID, MIRA) !== 'idle') return null
    const turn = this.hub.turns.get(MIRA)
    if (!turn || !(turn.failed || turn.silent || turn.unanswered)) return null
    const messages = [...this.hub.messages.values()]
    const original = messages.findLast(m => m.author?.kind === 'human' && m.trust === 'principal')
    return original && !messages.some(m => m.replyTo === original.id) ? original.id : null
  }

  /** A source is an immutable domain record; bookkeeping and raw tool logs are never search results. */
  materialize(project, event) {
    let text, trust = 'system', title = event.type, threadId = event.threadId ?? null
    switch (event.type) {
      case 'connector.record':
        if (event.deleted) return null
        text = event.text;trust = 'external';title = event.title;break
      case 'observation.accepted':
        text = event.text;trust = event.trust;title = event.title || event.app || '设备观察';break
      case 'observation.summary':
        text = event.text;trust = event.trust;title = event.title;break
      case 'message.posted':
        if (project.hub && event.author?.kind !== 'human') return null
        text = event.text;trust = event.trust ?? 'relay';title = event.author?.kind === 'human' ? '用户消息' : '项目回复';break
      case 'thread.opened': text = `${event.title}\n${event.brief || ''}\n${event.note || ''}`.trim();title = event.title;break
      case 'thread.updated':
        text = [event.patch?.summary, event.patch?.state ? `任务状态：${STATE_LABEL[event.patch.state] || event.patch.state}` : null,
          event.patch?.resolved === true ? '任务已归档' : null].filter(Boolean).join('\n')
        if (!text) return null
        title = project.threads.get(threadId)?.title || '任务更新';break
      case 'decision.requested': text = event.question;title = '等待拍板';break
      case 'decision.answered': {
        const d = project.decisions.get(event.decisionId);threadId = d?.threadId ?? threadId
        text = `${d?.question || '拍板'}：${d?.options?.[event.chosen]?.label || event.chosen}`;title = '用户拍板';break
      }
      case 'pc.window': case 'pc.signal':
        text = event.summary || event.text;trust = 'observation';title = event.title || event.app || '设备活动';break
      case 'pc.activity':
        // The computer's history for one window: what the model said was being done, each line pointing at its observations.
        text = event.activities.map(a => `${a.title}${a.detail ? `：${a.detail}` : ''}${a.apps.length ? `（${a.apps.join('、')}）` : ''}`).join('\n')
        trust = 'observation';title = '电脑活动';break
      case 'external.received':
        text = event.text || event.body || event.summary || (event.content ? JSON.stringify({ subject: event.subject, content: event.content }) : null)
        if (typeof text !== 'string') return null
        trust = 'external';title = '外部事件';break
      default: return null
    }
    const projectId = project.hub ? event.projectRef ?? null : project.id
    const observation = ['observation.accepted', 'observation.summary'].includes(event.type) ? this.observations?.view(event) : null
    const newer = event.type === 'observation.summary' ? this.observations?.summaries.get(event.windowId) : null
    const retention = project.hub ? this.retention?.sourceStatus(event) : null
    return { ref: `${project.id}#${event.seq}`, kind: event.type, source: event.source ?? null, title, text: (text || '').slice(0, 20000), truncated: (text || '').length > 20000, trust,
      ...(observation ? { media: observation.media, mediaState: observation.mediaState, mediaExpiresAt: observation.mediaExpiresAt, source: observation.source, clockSkewMs: observation.clockSkewMs, localSeq: observation.localSeq, sourceRefs: event.refs ?? [], summaryVersion: event.version ?? null } : {}),
      ...(event.type === 'pc.activity' ? { sourceRefs: [...new Set(event.activities.flatMap(a => a.refs))], summaryVersion: event.version } : {}),
      ...(event.type === 'connector.record' && this.connectors ? { sourceState: this.connectors.isCurrent(event) ? 'current' : this.connectors.records.get(event.connectorId + '|' + event.externalId)?.deleted ? 'deleted' : 'historical' } : {}),
      ...(newer && newer.seq !== event.seq ? { supersededBy: `hub#${newer.seq}` } : {}),
      projectId, projectName: projectId ? this.projects.projects.get(projectId)?.name || projectId : null,
      threadId, threadTitle: threadId ? project.threads.get(threadId)?.title ?? null : null,
      connectorId: event.connectorId ?? null, connectorName: event.connectorName ?? null, externalId: event.externalId ?? null, externalContext: event.context ?? null, sourceTruncated: event.truncated === true,
      messageId: event.messageId ?? null, deviceId: event.deviceId ?? null, deviceName: event.deviceName ?? null,
      ...(event.type === 'observation.accepted' && event.source === 'lark' && event.correlationId ? { conversation: event.correlationId } : {}),
      happenedAt: event.occurredAt ?? event.startedAt ?? event.start ?? event.at, receivedAt: event.receivedAt ?? event.at,
      ...retention,
      ...(event.sourceExpired || retention?.sourceState === 'expired' ? { title: retention?.sourceCleanupPending ? '原文已到期，清理待完成' : '原文已按保留设置清理', text: '', externalContext: null, sourceState: 'expired', sourceExpiredAt: event.sourceExpiredAt ?? retention?.sourceExpiredAt, truncated: false, sourceTruncated: false } : {}) }
  }

  source(ref, sessionId, applyRetention = true) {
    // Reading a saved reference also applies newly reached deadlines. Pending
    // cleanup still returns its masked metadata so old citations remain usable.
    if (applyRetention) { try { this.retention?.collect() } catch {} }
    const match = /^([\w-]+)#([1-9]\d*)$/.exec(String(ref))
    const project = match && (match[1] === HUB_ID ? this.hub : this.projects.projects.get(match[1]))
    const seq = match && Number(match[2]), direct = project?.events[seq - 1]
    const event = direct?.seq === seq ? direct : project?.events.find(e => e.seq === seq)
    const item = event && this.materialize(project, event)
    if (!item) throw new Error('来源不存在或不是可引用的资料')
    if (sessionId) this.provided(sessionId, [item.ref])
    return item
  }

  provided(sessionId, refs) {
    if (refs.length) this.hubStore.append(HUB_ID, { type: 'personal.evidence.provided', sessionId, refs })
  }

  search({ query = '', projectId, since, until, limit = 20, includePersonal = false } = {}, sessionId) {
    if (typeof query !== 'string' || query.length > 200) throw new Error('检索词最多200字')
    if (projectId && !this.projects.projects.has(projectId)) throw new Error('没有这个项目')
    const start = time(since), end = time(until)
    if (start !== undefined && end !== undefined && start >= end) throw new Error('时间范围无效')
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('每页检索1–40条')
    this.retention?.collect()
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean), items = []
    let total = 0
    const order = (a, b) => b.happenedAt - a.happenedAt || a.ref.localeCompare(b.ref)
    this.index.metrics.lastCandidates = 0
    try {
      for (const { ref } of this.index.candidates({ terms, projectId, start, end, includePersonal })) {
        this.index.metrics.lastCandidates++
        const source = this.source(ref, undefined, false)
        if (projectId && source.projectId !== projectId || start !== undefined && source.happenedAt < start || end !== undefined && source.happenedAt >= end) continue
        if (!terms.every(term => searchText(source).includes(term))) continue
        total++;items.push(source);items.sort(order)
        if (items.length > limit) items.pop()
      }
    } catch { throw Error('检索索引暂不可用，请重试；原始资料未受影响') }
    const selected = items.slice(0, limit).map(item => ({ ...item, text: item.text.slice(0, 1200), truncated: item.text.length > 1200 }))
    if (sessionId) this.provided(sessionId, selected.map(item => item.ref))
    return { items: selected, hasMore: total > limit, total }
  }

  /**
   * The Feishu conversations the device collected, or one of them read in order. A search hit is one line; who said
   * what to whom only reads as a whole conversation. Only what the device collected, never Feishu itself.
   */
  feishuChat({ conversation, query = '', since, until, limit = 60 } = {}, sessionId) {
    if (typeof query !== 'string' || query.length > 200) throw new Error('检索词最多200字')
    const start = time(since), end = time(until)
    if (start !== undefined && end !== undefined && start >= end) throw new Error('时间范围无效')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每次读1–100条')
    this.retention?.collect()
    const within = e => (start === undefined || e.occurredAt >= start) && (end === undefined || e.occurredAt < end) && !this.retention?.isExpired(e)
    const iso = at => new Date(at).toISOString()
    const chats = [...feishuConversations(this.hub).values()].map(chat => {
      const messages = chat.messages.filter(within)
      return { id: chat.id, title: messages.at(-1)?.title || '飞书会话', messages, people: [...new Set(messages.filter(e => !ownWords(e)).map(e => speakerOf(e.text)).filter(Boolean))].slice(0, 12) }
    }).filter(chat => chat.messages.length)
    if (conversation === undefined || conversation === '') {
      const term = query.trim().toLowerCase()
      const found = chats.filter(chat => !term || [chat.title, ...chat.people].some(text => text.toLowerCase().includes(term)))
        .sort((a, b) => b.messages.at(-1).occurredAt - a.messages.at(-1).occurredAt)
      return { conversations: found.slice(0, limit).map(chat => ({ conversation: chat.id, title: chat.title, people: chat.people, messages: chat.messages.length,
        mine: chat.messages.filter(ownWords).length, firstAt: iso(chat.messages[0].occurredAt), lastAt: iso(chat.messages.at(-1).occurredAt) })), total: found.length, hasMore: found.length > limit }
    }
    const chat = chats.find(c => c.id === conversation)
    if (!chat) throw new Error('没有收集到这个飞书会话（或这段时间里没有消息）；不带 conversation 可以列出收集到的会话')
    const messages = chat.messages.slice(-limit).map(e => {
      const item = this.source(`${HUB_ID}#${e.seq}`, undefined, false)
      return { ref: item.ref, at: iso(item.happenedAt), mine: ownWords(e), trust: item.trust, text: item.text.slice(0, 1200), truncated: item.text.length > 1200 }
    })
    if (sessionId) this.provided(sessionId, messages.map(m => m.ref))
    return { conversation: chat.id, title: chat.title, people: chat.people, messages, total: chat.messages.length, hasEarlier: chat.messages.length > limit }
  }

  validateRefs(refs = []) {
    if (!Array.isArray(refs) || refs.length > 12 || refs.some(r => typeof r !== 'string')) throw new Error('来源需为最多12条引用')
    return [...new Set(refs)].map(ref => this.source(ref))
  }

  reply({ text, refs = [], replyTo }, sessionId) {
    const body = required(text, '回复'), original = this.hub.messages.get(replyTo)
    if (!original || original.author?.kind !== 'human' || original.trust !== 'principal') throw new Error('回复必须指向个人对话里的用户消息')
    // Words typed in the assistant's own session are answered there, in text. A later wake used to answer them again
    // through this tool (fresh-install check run, 2026-11-16). A retry the owner asks for still gets its answer.
    const answered = original.native === true ? this.hub.events.findLast(e => e.type === 'message.posted' && e.author?.kind === 'assistant' && e.replyTo === replyTo) : undefined
    if (answered && !this.hub.events.some(e => e.seq > answered.seq && e.type === 'mira.requested' && e.reason === 'conversation' && e.replyTo === replyTo)) {
      throw new Error('这条消息是他直接在你的会话里打的，你当时已经回答过了，不要再答一遍。没有新的事要告诉他，就调用 hub_no_reply 结束这一轮')
    }
    if (/\b(?:p_[\w-]+|hub)#[1-9]\d*/.test(body)) throw new Error('来源编号放在refs数组中，正文用项目名和易读说明；界面会生成来源按钮')
    const sources = this.validateRefs(refs)
    const provided = new Set(this.hub.events.filter(e => e.type === 'personal.evidence.provided' && e.sessionId === sessionId).flatMap(e => e.refs))
    if (sources.some(s => !provided.has(s.ref))) throw new Error('引用的资料还未提供给当前会话，请先检索或读取来源')
    const event = this.hubStore.append(HUB_ID, { type: 'message.posted', messageId: this.hubStore.newMessageId(),
      author: { kind: 'assistant', id: MIRA }, trust: 'relay', text: body, threadId: null, mentions: [], to: [],
      refs: sources.map(s => s.ref), replyTo })
    return { ok: true, messageId: event.messageId }
  }

  handoff({ requestId, projectId, messageId, text, refs = [], note, typed = false }) {
    const key = requestKey(requestId), project = this.projects.projects.get(projectId), original = this.hub.messages.get(messageId)
    if (!project || project.hub) throw new Error('没有目标项目')
    if (!original || original.author?.kind !== 'human' || original.trust !== 'principal') throw new Error('只能转交个人对话中用户写下的需求')
    const body = required(text ?? original.text, '交给项目的需求'), sources = this.validateRefs(refs)
    const extra = typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 600) : undefined
    const fingerprint = digest({ projectId, messageId, text: body, refs: sources.map(s => s.ref), ...(extra ? { note: extra } : {}) })
    const id = 'handoff_' + digest(key).slice(0, 32)
    const intent = this.hub.events.find(e => e.type === 'personal.handoff.requested' && e.handoffId === id)
    if (intent && intent.fingerprint !== fingerprint) throw new Error('同一交接请求的重试内容不一致')
    if (!intent) this.hubStore.append(HUB_ID, { type: 'personal.handoff.requested', handoffId: id, requestId: key, fingerprint,
      projectRef: projectId, sourceMessageId: messageId, text: body, refs: sources.map(s => s.ref), ...(extra ? { note: extra } : {}) })
    let target = project.events.find(e => e.type === 'message.posted' && e.handoff?.id === id)
    if (!target) {
      const result = this.projectActions.ownerPost({ projectId, text: body, ...(typed ? { typed: body } : {}) }, { handoff: { id, sourceMessageId: messageId,
        sourceRef: `hub#${original.seq}`, sourceText: original.text, context: sources, ...(extra ? { note: extra } : {}) } })
      target = project.events.find(e => e.messageId === result.messageId)
    } else this.projectActions.driver.deliver(target, 'personal-handoff')
    let receipt = this.hub.events.find(e => e.type === 'personal.handoff.completed' && e.handoffId === id)
    if (!receipt) receipt = this.hubStore.append(HUB_ID, { type: 'personal.handoff.completed', handoffId: id,
      projectRef: projectId, sourceMessageId: messageId, messageId: target.messageId, targetRef: `${projectId}#${target.seq}` })
    return { ok: true, handoffId: id, projectId, messageId: target.messageId, targetRef: receipt.targetRef }
  }

  // ------------------------------------------------------------ v4: Mira acts on the owner's request

  /** The owner's own message in this conversation; every action Mira takes cites one. */
  ownerWords(messageId) {
    // v4: words typed straight into Mira's own Session reach her without an id; she cites them as "latest".
    if (messageId === 'latest') messageId = this.hub.events.findLast(e => e.type === 'message.posted' && e.native === true && e.author?.kind === 'human')?.messageId
    const message = this.hub.messages.get(messageId)
    if (!message || message.author?.kind !== 'human' || message.trust !== 'principal') throw new Error('需要引用个人对话里用户本人的原话（user_message_id）')
    return message
  }

  /** v4: the owner typed into Mira's own Session. She already has the words as an ordinary turn, so nobody is woken. */
  mirrorNative({ text }) {
    const event = this.hubStore.append(HUB_ID, { type: 'message.posted', messageId: this.hubStore.newMessageId(), threadId: null,
      author: { kind: 'human', id: 'owner' }, trust: 'principal', text: required(text, '消息'), mentions: [], to: [], native: true })
    return { ok: true, messageId: event.messageId }
  }

  /** v4: Mira answered in text in her own Session, which is what the owner reads; the conversation records it. */
  mirrorReply({ text }) {
    const replyTo = this.hub.events.findLast(e => e.type === 'message.posted' && e.native === true && e.author?.kind === 'human')?.messageId ?? null
    const event = this.hubStore.append(HUB_ID, { type: 'message.posted', messageId: this.hubStore.newMessageId(), threadId: null,
      author: { kind: 'assistant', id: MIRA }, trust: 'relay', text: required(text, '回复'), mentions: [], to: [], native: true, refs: [], replyTo })
    return { ok: true, messageId: event.messageId }
  }

  task(projectId, threadId) {
    const project = this.projects.projects.get(projectId)
    if (!project || project.hub) throw new Error('没有这个项目')
    const thread = project.threads.get(threadId)
    if (!thread) throw new Error('这个项目里没有这个任务')
    return { project, thread }
  }

  /** What Mira did, shown in the conversation as an 「已执行」 line under the owner's message. */
  recordAction({ kind, text, sub, projectId, threadId, messageId }) {
    const event = this.hubStore.append(HUB_ID, { type: 'personal.action', actionKind: kind, text, ...(sub ? { sub } : {}),
      projectRef: projectId ?? null, threadId: threadId ?? null, sourceMessageId: messageId })
    return { ok: true, actionSeq: event.seq }
  }

  taskMessage({ projectId, threadId, text, messageId }) {
    const original = this.ownerWords(messageId), { project, thread } = this.task(projectId, threadId)
    messageId = original.id
    this.projectActions.miraRelay({ projectId, threadId, text: required(text, '要转达的话'), sourceRef: `hub#${original.seq}` })
    return this.recordAction({ kind: 'message', text: `给「${thread.title}」发了话`, sub: `${project.name} · ${required(text, '要转达的话').slice(0, 80)}`, projectId, threadId, messageId })
  }

  answerDecision({ projectId, threadId, option, messageId }) {
    messageId = this.ownerWords(messageId).id
    const { project, thread } = this.task(projectId, threadId)
    const open = [...project.decisions.values()].filter(d => d.threadId === threadId && d.chosen === null && !d.withdrawn)
    if (open.length === 0) throw new Error('这个任务现在没有等你回答的拍板')
    if (open.length > 1) throw new Error(`这个任务有 ${open.length} 个拍板在等，请让用户说明回答哪一个`)
    const decision = open[0]
    const chosen = Number.isInteger(option) ? option : decision.options.findIndex(o => o.label === option)
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= decision.options.length) throw new Error(`选项无效；可选：${decision.options.map((o, i) => `${i}=${o.label}`).join('，')}`)
    this.projectActions.answerDecision({ projectId, decisionId: decision.id, chosen })
    return this.recordAction({ kind: 'decision', text: `回复了「${thread.title}」的拍板：${decision.options[chosen].label}`, sub: `${project.name} · ${decision.question}`, projectId, threadId, messageId })
  }

  /**
   * The assistant passes one of the owner's requests on to a project. What lands there under the owner's name is the
   * owner's own words, checked to stand in their message word for word. Anything the assistant adds travels beside them
   * as its note, never as the owner's instruction. (Fresh-install run, 2026-11-16: the assistant's rewrite added
   * requirements the owner never stated, was logged as theirs, and the task took 11.6 minutes instead of 99 seconds.)
   */
  openTask({ projectId, quote, note, text, messageId, refs = [] }) {
    const original = this.ownerWords(messageId)
    messageId = original.id
    const project = this.projects.projects.get(projectId)
    if (!project || project.hub) throw new Error('没有这个项目')
    const own = typeof original.typed === 'string' && original.typed !== '' ? original.typed : original.text
    const said = [quote, text].map(value => typeof value === 'string' ? value.trim() : '').find(value => value !== '' && own.includes(value))
    if (said === undefined) throw new Error('quote 要填他那条消息里关于这件事的原话，一字不差（平台会核对）：送进项目的就是这句原话，不改写、不扩写。读懂它必需的背景放 note')
    const extra = typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 600) : undefined
    const result = this.handoff({ requestId: 'mira-open-' + digest({ projectId, messageId, body: said, ...(extra ? { note: extra } : {}) }).slice(0, 40), projectId, messageId, text: said, refs, note: extra, typed: true })
    this.recordAction({ kind: 'open', text: `把这件事交给了「${project.name}」`, sub: extra ? `助理补充：${extra}` : '项目助理会开成任务；资料只作参考，不算你的指令', projectId, messageId })
    return result
  }

  /**
   * A new project on the owner's words, made exactly as the page's 新建项目 makes it (default assistants, isolated
   * workspace when the folder is a Git repository). The same words and name again return that project, so a retry is no duplicate.
   */
  createProject({ name, instructions, cwd }, { messageId } = {}) {
    messageId = this.ownerWords(messageId).id
    const title = required(name, '项目名', 80)
    const earlier = this.hub.events.findLast(e => e.type === 'personal.action' && e.actionKind === 'project' && e.sourceMessageId === messageId && this.projects.projects.get(e.projectRef)?.name === title)
    if (earlier) return { ok: true, existing: true, projectId: earlier.projectRef }
    const { projectId } = this.projectActions.createProject({ name: title, instructions, cwd, workspaceMode: 'auto', members: STARTER_MEMBERS })
    const folder = this.projects.get(projectId).cwd
    return { ...this.recordAction({ kind: 'project', text: `新建了项目「${title}」`, sub: folder ? `目录 ${folder}` : '没指定目录，用平台给的默认目录', projectId, messageId }), projectId }
  }

  /**
   * Deleting moves the project to the trash, where nothing is erased and restoreProject brings it back, so the owner's
   * words are enough (no second confirmation), and one message may name several projects.
   */
  async deleteProject({ projectId }, { messageId } = {}) {
    messageId = this.ownerWords(messageId).id
    const project = this.projects.projects.get(projectId)
    if (!project || project.hub) throw new Error(`没有这个项目。现有项目：${listed(this.projects.projects)}`)
    await this.projectActions.deleteProject({ projectId })
    return this.recordAction({ kind: 'delete', text: `把项目「${project.name}」移进了回收站`, sub: '没有抹掉任何东西，随时能恢复', projectId, messageId })
  }

  restoreProject({ projectId }, { messageId } = {}) {
    messageId = this.ownerWords(messageId).id
    if (!this.projects.trash.has(projectId)) throw new Error(`回收站里没有这个项目。回收站里有：${listed(this.projects.trash)}`)
    const { name, pausedAutomations } = this.projectActions.restoreProject({ projectId })
    return this.recordAction({ kind: 'restore', text: `把项目「${name}」从回收站恢复了`, sub: pausedAutomations ? `它的 ${pausedAutomations} 个自动任务还停着，要跑得再开` : undefined, projectId, messageId })
  }

  /** Archiving takes a task off the lists and keeps its record; the project page can bring it back. */
  archiveTask({ projectId, threadId }, { messageId } = {}) {
    messageId = this.ownerWords(messageId).id
    const { thread } = this.task(projectId, threadId)
    if (thread.resolved) throw new Error('这个任务已经归档了')
    this.projectActions.ownerUpdateThread({ projectId, threadId, resolved: true })
    return this.recordAction({ kind: 'archive', text: `归档了「${thread.title}」`, sub: '记录还在，项目页里能找回', projectId, threadId, messageId })
  }

  /**
   * Accepting merges and cannot be undone, so Mira asks first and the owner answers in this conversation:
   * the cited confirmation must come after Mira's question and may authorize one acceptance only.
   */
  async acceptTask({ projectId, threadId, confirmMessageId }) {
    const confirm = this.ownerWords(confirmMessageId)
    confirmMessageId = confirm.id
    const asked = [...this.hub.messages.values()].some(m => m.author?.kind === 'assistant' && m.seq < confirm.seq)
    if (!asked) throw new Error('验收前要他确认：先用hub_reply向用户说明改动并请他确认（他在你会话里直接打字时，用文字说明即可），再引用他确认的那条消息（直接打字的确认填 latest）')
    if (this.hub.events.some(e => e.type === 'personal.action' && e.actionKind === 'accept' && e.sourceMessageId === confirmMessageId)) throw new Error('这条确认已经用过一次了')
    const { project, thread } = this.task(projectId, threadId)
    if (thread.resolved || thread.state !== 'review_ready') throw new Error('这个任务现在不在「待验收」')
    if (project.gitlab) {
      if (!this.gitlab) throw new Error('GitLab 验收服务尚未就绪')
      await this.gitlab.accept(projectId, threadId, thread.gitlab?.sha)
    } else this.projectActions.ownerUpdateThread({ projectId, threadId, resolved: true, state: 'done' })
    return this.recordAction({ kind: 'accept', text: `验收了「${thread.title}」${project.gitlab ? '，平台已合并' : `；没接 GitLab，${landingNote(thread)}`}`, sub: `依据你这句「${confirm.text.slice(0, 40)}」`, projectId, threadId, messageId: confirmMessageId })
  }

  // ------------------------------------------------------------ v4: which model each assistant runs on

  /** Mira herself and every project's active assistants: the model configured for each and the one it last ran on. */
  async models(catalog) {
    catalog ??= await this.projectActions.driver.modelCatalog()
    const row = (project, member, driver, projectId) => ({ projectId, projectName: projectId ? project.name : null, member: member.id, name: member.name, role: member.role,
      configured: member.modelSelection ?? null, running: driver.memberModel(project, member.id) })
    return {
      default: catalog.default ?? null,
      groups: (catalog.groups ?? []).map(g => ({ id: g.id, name: g.name ?? g.id, models: g.models.map(m => ({ id: m.id, name: m.name ?? m.id })) })),
      agents: [row(this.hub, this.hub.members.find(m => m.id === MIRA), this.driver, null),
        ...[...this.projects.projects.values()].filter(p => !p.hub).flatMap(p => p.members.filter(m => m.kind === 'assistant' && m.active !== false).map(m => row(p, m, this.projectActions.driver, p.id)))],
      // The owner's model strategy in their own words: '' for the personal assistant, then each project by id.
      strategies: Object.fromEntries([['', this.hub.modelStrategy ?? ''], ...[...this.projects.projects.values()].filter(p => !p.hub).map(p => [p.id, p.modelStrategy ?? ''])]),
    }
  }

  /**
   * Point one assistant at a model DSH offers, or back to DSH's default; no project means Mira herself. Running sessions
   * switch on their next step. From Mira's tool it cites the owner's own words and shows as 「已执行」; from the page it is the owner's own act.
   */
  async setModel({ projectId, member: ref, provider, model }, { messageId } = {}) {
    if (messageId !== undefined) messageId = this.ownerWords(messageId).id
    if (!projectId && ref && String(ref).trim().toLowerCase() !== MIRA) throw new Error('改项目里助理的模型要给 project_id；不给 project_id 只改你自己')
    const project = projectId ? this.projects.projects.get(projectId) : this.hub
    if (!project || (projectId && project.hub)) throw new Error('没有这个项目')
    const member = projectId ? findAssistant(project, ref) : project.members.find(m => m.id === MIRA)
    const catalog = await this.projectActions.driver.modelCatalog()
    const selection = pickModel(catalog, { provider, model })
    const label = modelLabel(catalog, selection), who = projectId ? `「${project.name}」的${member.name}` : '个人助理（你自己）'
    const current = member.modelSelection ?? null
    if (current?.provider === selection?.provider && current?.model === selection?.model) return { ok: true, unchanged: true, text: `${who}已经配置为 ${label}` }
    ;(projectId ? this.projects : this.hubStore).append(project.id, { type: 'member.model', memberId: member.id, modelSelection: selection,
      by: messageId !== undefined ? { kind: 'assistant', id: MIRA } : { kind: 'human', id: 'owner' }, ...(messageId !== undefined ? { sourceMessageId: messageId } : {}) })
    if (messageId === undefined) return { ok: true, memberId: member.id, modelSelection: selection }
    return { ...this.recordAction({ kind: 'model', text: projectId ? `把${who}换成了 ${label}` : `把我自己的模型换成了 ${label}`, sub: '下一步起生效，不换会话；正在跑的这一步会先跑完', projectId: projectId ?? null, messageId }),
      effect: `${who}已开着的会话（包括进行中的任务）下一步就用 ${label}，不需要新任务或新会话；正在跑的这一步先跑完。` }
  }

  /**
   * Keep the owner's model strategy for the personal assistant (no project) or one project, in their own words. Applying it
   * is hub_set_model's job, one assistant at a time; this only remembers what they want. From the page it is the owner's
   * own act; from Mira's tool it cites their words.
   */
  setModelStrategy({ projectId, text }, { messageId } = {}) {
    if (messageId !== undefined) messageId = this.ownerWords(messageId).id
    const project = projectId ? this.projects.projects.get(projectId) : this.hub
    if (!project || (projectId && project.hub)) throw new Error('没有这个项目')
    const value = String(text ?? '').trim()
    if ([...value].length > 500) throw new Error('模型策略写 500 字以内')
    if ((project.modelStrategy ?? '') === value) return { ok: true, unchanged: true }
    ;(projectId ? this.projects : this.hubStore).append(project.id, { type: 'project.updated', modelStrategy: value,
      by: messageId !== undefined ? { kind: 'assistant', id: MIRA } : { kind: 'human', id: 'owner' }, ...(messageId !== undefined ? { sourceMessageId: messageId } : {}) })
    if (messageId === undefined) return { ok: true, modelStrategy: value }
    const where = projectId ? `「${project.name}」` : '个人助理'
    return this.recordAction({ kind: 'model', text: value ? `记下了${where}的模型策略` : `清掉了${where}的模型策略`, sub: value.slice(0, 80), projectId: projectId ?? null, messageId })
  }

  snapshot({ before, limit = 100 } = {}) {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('历史消息游标无效')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('历史消息每页1–100条')
    const messages = this.hub.chat.map(id => this.hub.messages.get(id)).filter(m => before === undefined || m.seq < before)
    const selected = messages.slice(-limit)
    return { enabled: true, status: this.driver.status(HUB_ID, MIRA), sessionId: this.hub.sessions.get(MIRA)?.sessionId ?? null,
      lastTurn: this.hub.turns.get(MIRA) ?? null, retryMessageId: this.retryMessageId(), hasMore: messages.length > selected.length,
      messages: selected.map(m => ({ id: m.id, seq: m.seq, at: m.at, text: m.text, typed: m.typed ?? null, native: m.native === true, author: m.author, refs: m.refs ?? [], replyTo: m.replyTo ?? null,
        replyToRef: m.replyTo && this.hub.messages.has(m.replyTo) ? `hub#${this.hub.messages.get(m.replyTo).seq}` : null })),
      handoffs: this.hub.events.filter(e => e.type === 'personal.handoff.completed').slice(-100).map(e => ({ id: e.handoffId, at: e.at, projectId: e.projectRef, sourceMessageId: e.sourceMessageId, messageId: e.messageId, targetRef: e.targetRef })),
      actions: this.hub.events.filter(e => e.type === 'personal.action').slice(-100).map(e => ({ seq: e.seq, at: e.at, kind: e.actionKind, text: e.text, sub: e.sub ?? null, projectId: e.projectRef, threadId: e.threadId, sourceMessageId: e.sourceMessageId })),
      projects: [...this.projects.projects.values()].filter(p => !p.hub).map(p => ({ id: p.id, name: p.name, threads: p.threadOrder.length,
        waiting: [...p.threads.values()].filter(t => !t.resolved && ['blocked', 'review_ready', 'failed'].includes(t.state)).length })),
      activity: [...this.hub.pc, ...this.hub.events.filter(e => e.type === 'observation.accepted' || e.type === 'connector.record' && this.connectors?.isCurrent(e))].map(e => this.materialize(this.hub, e)).filter(Boolean).sort((a, b) => b.happenedAt - a.happenedAt).slice(0, 20),
      observationDevices: this.observations?.snapshot({ limit: 1 }).devices ?? [],
      retention: this.retention?.snapshot() ?? null,
      connectors: this.connectors?.snapshot() ?? { configured: false, items: [], label: '邮件与飞书连接器尚未配置' },
      // The owner's look for the assistant (null until set: the page then offers the first-run studio).
      look: this.hub.assistantLook ?? null }
  }
}

/** Projects as the assistant is told about them, so a wrong id can be corrected from the error. */
function listed(projects) {
  return [...projects.values()].filter(p => !p.hub).map(p => `${p.name}（${p.id}）`).join('、') || '（没有）'
}

/**
 * DSH's own tools personal Mira may use besides hers: look things up on the web and arrange her own later turns.
 * Commands and file writes stay with project executors, since she reads untrusted Feishu and screen text.
 */
export const PERSONAL_NATIVE_TOOLS = ['web_search', 'web_fetch', 'schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete']

/** True when `filePath` is an absolute path to an existing file inside `root`, after resolving `..` and symlinks. */
function insideRoot(filePath, root) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return false
  try {
    const real = realpathSync(filePath), base = realpathSync(root)
    return real.startsWith(base + sep)
  } catch { return false }
}

/**
 * The personal agent retrieves, advises, searches the web and schedules itself; doing work goes to a project.
 * DSH hands a file the owner attaches to her as a line naming its saved path under `<DSH_HOME>/attachments`, so with
 * `attachmentRoot` she may `read` files there and nowhere else.
 */
export function restrictPersonalAgent(agent, hubTools, attachmentRoot) {
  const allowed = new Set([...hubTools, ...PERSONAL_NATIVE_TOOLS, ...(attachmentRoot ? ['read'] : [])])
  agent.ctx.tools.presentAs('native')
  const denied = agent.ctx.tools.schemas().map(t => t.name).filter(name => !allowed.has(name))
  if (denied.length) agent.ctx.tools.restrict({ deny: denied })
  agent.ctx.tools.guard(exec => {
    if (!allowed.has(exec.name)) return '个人助理不直接跑命令或改文件；要动手的事用 hub_task_open 交给项目，或由用户操作'
    if (exec.name === 'read' && !insideRoot(exec.arguments?.file_path, attachmentRoot)) return `个人助理只能读用户发给她的附件（消息里给出的保存路径，绝对路径）；${hubTools.has('hub_mac_files') ? '用户自己电脑上的文件用 hub_mac_files 读，' : ''}别的文件交给项目执行者去读`
  })
}
