/**
 * The day across every project: what happened, what waits for the owner,
 * where each project stands, and what the computer was doing. Computed from
 * the logs on every request, so it needs no model and is never stale; Mira's
 * own words about the day (the morning and evening recap) ride along from
 * the hub log.
 */

import { COORDINATOR, MIRA, dayKey, workerKey } from './store.js'
import { STATE_LABEL, escapeText } from './protocol.js'
import { activityRows } from './computer-history.js'
import { owedReplies } from './followups.js'
import { ATTENTION_DAILY_WAKES, attentionMode, attentionWokeToday } from './attention.js'
import { boardView } from './board-digest.js'

const DAY_MS = 24 * 60 * 60_000
const PC_WINDOW_MIN = 10

/** [start, end) of a local calendar day given as YYYY-MM-DD (or the day of `now`). */
export function dayBounds(day, now = Date.now()) {
  const key = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dayKey(now)
  const [y, m, d] = key.split('-').map(Number)
  const start = new Date(y, m - 1, d).getTime()
  // Next local midnight, which is not always 24h away (DST).
  const end = new Date(y, m - 1, d + 1).getTime()
  return { day: key, start, end: end > start ? end : start + DAY_MS }
}

export const ref = (projectId, seq) => `${projectId}#${seq}`

/**
 * Where a hub card's matter came from, read off the events it cites (refs "hub#seq"): a Feishu chat or another app the
 * computer saw, or the computer itself. Mechanical: only the cited event's own fields, never the card's wording. Null when
 * no cited event names a source.
 */
export function cardSource(card, hub) {
  for (const cited of card?.refs ?? []) {
    const m = /^hub#(\d+)$/.exec(String(cited))
    if (m === null) continue
    const seq = Number(m[1]), at = hub.events[seq - 1]
    const event = at?.seq === seq ? at : hub.events.find(e => e.seq === seq)
    if (event === undefined) continue
    if (event.type === 'feishu.attention') return { app: '飞书', where: event.title ?? null }
    if (event.type === 'observation.accepted' && typeof event.app === 'string' && event.app) return { app: event.app, where: event.title ?? null }
    if (event.type === 'pc.activity') return { app: '电脑', where: event.deviceName ?? null }
  }
  return null
}

function who(project, author) {
  if (author?.kind === 'human') return '你'
  if (author?.kind === 'system') return '系统'
  return project.members.find(m => m.id === author?.id)?.name ?? author?.id ?? ''
}

function clip(text, n = 60) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/** One project event as a line of the day's timeline, or undefined for bookkeeping. */
export function timelineLine(project, event) {
  const thread = event.threadId ? project.threads.get(event.threadId) : undefined
  const title = thread ? `「${thread.title}」` : ''
  switch (event.type) {
    case 'thread.opened':
      return { kind: 'thread', text: `开了线程「${event.title}」，交给${project.members.find(m => m.id === event.assignee)?.name ?? event.assignee}` }
    case 'thread.updated': {
      const state = event.patch?.state
      if (state === 'done') return { kind: 'done', text: `${title}完成` }
      if (state === 'review_ready') return { kind: 'review', text: `${title}交付，待验收` }
      if (state === 'failed') return { kind: 'failed', text: `${title}失败` }
      if (event.patch?.resolved === true) return { kind: 'done', text: `${title}归档` }
      return undefined
    }
    case 'decision.requested':
      return { kind: 'decision', text: `${title}请你拍板：${clip(event.question, 40)}` }
    case 'decision.answered': {
      const decision = project.decisions.get(event.decisionId)
      return { kind: 'decision', text: `你拍板「${clip(decision?.question, 30)}」：${decision?.options?.[event.chosen]?.label ?? event.chosen}` }
    }
    case 'message.posted':
      if (event.author?.kind !== 'human') return undefined
      return { kind: 'owner', text: `你${thread ? `在${title}里` : '在项目对话里'}说：${clip(event.text, 40)}` }
    case 'card.proposed':
      return { kind: 'card', text: `助理提醒：${event.title}` }
    case 'turn.failed':
      return { kind: 'failed', text: `${event.key === COORDINATOR ? '项目助理' : event.key === MIRA ? '记忆助理' : '一位助理'}唤醒失败` }
    default:
      return undefined
  }
}

function threadRow(project, t) {
  const done = t.checklist.filter(i => i.done).length
  return {
    id: t.id, title: t.title, state: t.state, stateLabel: STATE_LABEL[t.state] ?? t.state, summary: t.summary,
    assigneeName: project.members.find(m => m.id === t.assignee)?.name ?? t.assignee,
    checklist: { done, total: t.checklist.length }, updatedAt: t.updatedAt,
    gitlab: t.gitlab ?? null, usesGitlab: Boolean(project.gitlab),
  }
}

/**
 * @param {import('./store.js').ProjectStore} store - the projects.
 * @param {any} [hub] - the hub project (hub.js), for the computer context, recaps, cards and memory.
 * @param {{ day?: string, now?: number, status?: (projectId: string, key: string) => string }} [options]
 */
/**
 * Why an assistant's card about one task has nothing left to say: the task is closed ('closed'), or 待你决定 already
 * lists the task itself ('listed'). null when the card still stands on its own.
 * @param {Map<string, any>} projects
 */
export function cardCovered(card, projects) {
  const thread = card.target?.threadId ? projects.get(card.target.projectId)?.threads.get(card.target.threadId) : undefined
  if (thread === undefined) return null
  if (thread.resolved === true || thread.state === 'done') return 'closed'
  return ['blocked', 'review_ready', 'failed'].includes(thread.state) ? 'listed' : null
}

export function buildDay(store, hub, { day, now = Date.now(), status, execution } = {}) {
  const { day: key, start, end } = dayBounds(day, now)
  const isToday = key === dayKey(now)
  const inDay = at => at >= start && at < end
  const projects = []
  const timeline = []
  const waiting = { decisions: [], review: [], failed: [] }
  const totals = { events: 0, opened: 0, done: 0, answered: 0, ownerMessages: 0, cards: 0 }

  const pcByProject = new Map()
  const pcDevices = new Map()
  for (const w of hub?.pc ?? []) {
    const at = w.occurredAt ?? w.startedAt ?? w.at
    if (inDay(at)) {
      const id = w.deviceId ?? 'legacy-local'
      const device = pcDevices.get(id) ?? { id, name: w.deviceName || w.deviceId || '本机历史记录', minutes: 0, windows: 0, lastAt: at, refs: [] }
      if (w.type === 'pc.window') { device.minutes += Number(w.minutes) || PC_WINDOW_MIN;device.windows++ }
      device.lastAt = Math.max(device.lastAt, at)
      device.refs.push(ref(hub.id, w.seq))
      pcDevices.set(id, device)
    }
    if (w.type !== 'pc.window' || !inDay(w.occurredAt ?? w.startedAt ?? w.at) || !w.projectRef) continue
    pcByProject.set(w.projectRef, (pcByProject.get(w.projectRef) ?? 0) + (Number(w.minutes) || PC_WINDOW_MIN))
  }

  for (const p of store.projects.values()) {
    if (p.hub) continue
    const events = p.events.filter(e => inDay(e.at))
    const row = {
      id: p.id, name: p.name, opened: [], done: [], review: [], blocked: [], failed: [], working: [],
      checklist: { done: 0, total: 0 }, events: events.length, lastAt: events.at(-1)?.at ?? null,
      pcMinutes: pcByProject.get(p.id) ?? 0, busy: [],
    }
    for (const e of events) {
      const line = timelineLine(p, e)
      if (line !== undefined) timeline.push({ at: e.at, ref: ref(p.id, e.seq), projectId: p.id, projectName: p.name, threadId: e.threadId ?? null, ...line })
      if (e.type === 'thread.opened') { row.opened.push(e.threadId); totals.opened++ }
      if (e.type === 'thread.updated' && (e.patch?.state === 'done' || e.patch?.resolved === true) && !row.done.includes(e.threadId)) { row.done.push(e.threadId); totals.done++ }
      if (e.type === 'decision.answered') totals.answered++
      if (e.type === 'message.posted' && e.author?.kind === 'human') totals.ownerMessages++
      if (e.type === 'card.proposed') totals.cards++
    }
    totals.events += events.length
    // Where the project stands now (for a past day: what it ended the day with is not kept, so "now" it is).
    for (const t of p.threads.values()) {
      if (t.resolved && !row.done.includes(t.id)) continue
      const r = threadRow(p, t)
      if (!t.resolved) {
        row.checklist.done += r.checklist.done
        row.checklist.total += r.checklist.total
      }
      if (t.state === 'review_ready' && !t.resolved) {
        row.review.push(r)
        waiting.review.push({ projectId: p.id, projectName: p.name, ...r, since: t.updatedAt })
      } else if (t.state === 'blocked' && !t.resolved) row.blocked.push(r)
      else if (t.state === 'failed' && !t.resolved) {
        row.failed.push(r)
        waiting.failed.push({ projectId: p.id, projectName: p.name, ...r, since: t.updatedAt })
      } else if (t.state === 'working' && !t.resolved) row.working.push(r)
      if (!t.resolved && (execution ? execution(p, t).active : status?.(p.id, workerKey(t.id)) === 'running')) row.busy.push(r.assigneeName)
    }
    row.opened = row.opened.map(id => p.threads.get(id)).filter(Boolean).map(t => threadRow(p, t))
    row.done = row.done.map(id => p.threads.get(id)).filter(Boolean).map(t => threadRow(p, t))
    for (const d of p.decisions.values()) {
      if (d.chosen !== null || d.withdrawn) continue
      waiting.decisions.push({
        projectId: p.id, projectName: p.name, id: d.id, threadId: d.threadId, threadTitle: p.threads.get(d.threadId)?.title ?? '',
        question: d.question, options: d.options, recommended: d.recommended, since: d.at, ref: ref(p.id, d.seq),
      })
    }
    // A project counts for the day if anything happened, or if it holds something for the owner.
    if (row.events > 0 || row.review.length + row.blocked.length + row.failed.length + row.working.length > 0) projects.push(row)
  }

  // The computer, folded by hour: one line per hour with the apps and what Mira's sensing made of them.
  const hours = new Map()
  for (const w of hub?.pc ?? []) {
    const at = w.occurredAt ?? w.startedAt ?? w.at
    if (!inDay(at)) continue
    if (w.type === 'pc.signal') {
      timeline.push({ at, ref: ref(hub.id, w.seq), projectId: null, projectName: '电脑', threadId: null, kind: 'pc', text: w.sourceExpired || hub?.sourceRetention?.isExpired(w) ? '原文已到保留期' : clip(w.text ?? w.kind, 60) })
      continue
    }
    const h = new Date(at).getHours()
    const entry = hours.get(h) ?? { at, minutes: 0, apps: new Set(), notes: [], refs: [], projects: new Set() }
    entry.minutes += Number(w.minutes) || PC_WINDOW_MIN
    if (w.app) entry.apps.add(String(w.app))
    if (w.summary && !w.sourceExpired && !hub?.sourceRetention?.isExpired(w) && entry.notes.length < 2) entry.notes.push(clip(w.summary, 40))
    if (w.projectRef) entry.projects.add(store.projects.get(w.projectRef)?.name ?? w.projectRef)
    entry.refs.push(ref(hub.id, w.seq))
    hours.set(h, entry)
  }
  for (const [h, e] of hours) {
    timeline.push({
      at: e.at, ref: e.refs[0], projectId: null, projectName: '电脑', threadId: null, kind: 'pc',
      text: `${String(h).padStart(2, '0')}:00 前后在电脑上 ${e.minutes} 分钟：${[...e.apps].slice(0, 3).join('、') || '文字摘要'}${e.notes.length ? `，${e.notes.join('；')}` : ''}${e.projects.size ? `（${[...e.projects].join('、')}）` : ''}`,
    })
  }
  // What the computer's history says the owner was doing, one row per thing (computer-history.js).
  for (const row of activityRows(hub, inDay)) {
    const project = row.projectId ? store.projects.get(row.projectId) : undefined
    timeline.push({ ...row, projectId: project ? row.projectId : null, projectName: '电脑', threadId: null, kind: 'activity', projectLabel: project?.name ?? null,
      text: `${row.title}${row.detail ? `：${row.detail}` : ''}${row.apps.length ? `（${row.apps.join('、')}${project ? `；${project.name}` : ''}）` : project ? `（${project.name}）` : ''}` })
  }
  timeline.sort((a, b) => a.at - b.at)

  const byAge = (a, b) => a.since - b.since
  waiting.decisions.sort(byAge)
  waiting.review.sort(byAge)
  waiting.failed.sort(byAge)
  projects.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  const recaps = (hub?.recaps ?? []).filter(r => r.day === key)
  // An open card whose task the board already lists, or whose task is closed, would be a second copy of that task
  // (fresh-install run, 2026-11-16: a 「请验收」 card stayed next to the task, and stayed after the task was accepted).
  const cards = hub === undefined ? [] : hub.cardOrder.map(id => hub.cards.get(id)).filter(c => c.state === 'open' ? cardCovered(c, store.projects) === null : inDay(c.at)).reverse()
    .map(c => ({ ...c, source: cardSource(c, hub) }))
  return {
    day: key, isToday, start, end, now,
    totals, waiting, projects, timeline,
    recap: { morning: recaps.filter(r => r.kind === 'morning').at(-1) ?? null, evening: recaps.filter(r => r.kind === 'evening').at(-1) ?? null, latest: recaps.at(-1) ?? null },
    cards,
    // Feishu messages that reached the owner directly and still wait for their reply: a reminder for now, so today only.
    followups: isToday && hub ? owedReplies(hub, now) : [],
    attention: hub ? { mode: attentionMode(hub), observed: hub.events.filter(e => e.type === 'feishu.attention.observed').length, wokeToday: attentionWokeToday(hub, now), dailyWakes: ATTENTION_DAILY_WAKES } : null,
    memory: hub?.hubMemory ?? null,
    // 关于你, for the 记忆 tab: what the owner told the assistant about themself, newest first. Forgotten lines are left out.
    about: hub ? hub.aboutOrder.map(id => hub.about.get(id)).filter(item => item.forgottenAt === null).reverse() : [],
    // What the owner told her to forget: hidden from her, kept here so it can be brought back.
    forgotten: hub ? { about: hub.aboutOrder.map(id => hub.about.get(id)).filter(item => item.forgottenAt !== null).slice(-20).reverse(), memory: hub.hubForgotten.slice(-20).reverse() } : { about: [], memory: [] },
    // 待你决定: the moving projects with their spoken paragraph, then the quiet ones (board-digest.js).
    board: isToday ? boardView(store, hub, now) : null,
    pcMinutes: [...hours.values()].reduce((n, e) => n + e.minutes, 0),
    devices: [...pcDevices.values()].sort((a, b) => b.lastAt - a.lastAt),
  }
}

const hhmm = at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const age = (now, at) => {
  const min = Math.max(0, Math.round((now - at) / 60_000))
  return min < 60 ? `${min} 分钟` : min < 48 * 60 ? `${Math.round(min / 60)} 小时` : `${Math.round(min / 1440)} 天`
}

/** The day as text for the steward's `today_read`: every fact carries the ref Mira cites. */
export function renderDay(view) {
  const lines = [`# ${view.day}${view.isToday ? '（今天）' : ''}`]
  const t = view.totals
  lines.push(`动态 ${t.events} 条：开线程 ${t.opened}，完成 ${t.done}，你拍板 ${t.answered}，你发言 ${t.ownerMessages}，记忆助理递卡 ${t.cards}。电脑上记录 ${view.pcMinutes} 分钟。`)
  lines.push('', '## 等你的')
  const w = view.waiting
  if (w.decisions.length + w.review.length + w.failed.length === 0) lines.push('（没有）')
  for (const d of w.decisions) lines.push(`- 拍板 [${d.ref}] ${escapeText(d.projectName)} ·「${escapeText(d.threadTitle)}」：${escapeText(d.question)}（等了 ${age(view.now, d.since)}）`)
  for (const r of w.review) lines.push(`- 待验收 ${escapeText(r.projectName)} ·「${escapeText(r.title)}」（线程 ${r.id}，${escapeText(r.assigneeName)}，等了 ${age(view.now, r.since)}）：${escapeText(r.summary || '')}`)
  for (const r of w.failed) lines.push(`- 失败 ${escapeText(r.projectName)} ·「${escapeText(r.title)}」（线程 ${r.id}）：${escapeText(r.summary || '')}`)
  lines.push('', '## 可能要你回复的飞书消息（有人单聊或 @你、之后你没在那个会话说过话；代码找出、模型判断过，只是提醒，不替你回）')
  if (!(view.followups ?? []).length) lines.push('（没有）')
  if (view.attention) lines.push(`主动提醒档位：${{ off: '关', observe: '观察（只记录，不叫醒个人助理）', auto: '自动' }[view.attention.mode]}${view.attention.observed ? `，观察期记下 ${view.attention.observed} 条` : ''}`)
  for (const f of view.followups ?? []) lines.push(`- [${f.ref}] ${escapeText(f.who)} · ${escapeText(f.title)}：${escapeText(f.ask)}（等了 ${age(view.now, f.since)}${f.count > 1 ? `，${f.count} 条` : ''}）原话「${escapeText(f.text)}」`)
  lines.push('', '## 各项目')
  if (view.projects.length === 0) lines.push('（没有活动的项目）')
  for (const p of view.projects) {
    lines.push(`- ${escapeText(p.name)}（${p.id}）：今天动态 ${p.events} 条，完成 ${p.done.length}，进行中 ${p.working.length}，等你 ${p.blocked.length}，待验收 ${p.review.length}，失败 ${p.failed.length}，清单 ${p.checklist.done}/${p.checklist.total}${p.pcMinutes ? `，电脑上 ${p.pcMinutes} 分钟` : ''}${p.busy.length ? `，${p.busy.join('、')}正在跑` : ''}`)
    for (const r of p.done) lines.push(`  - 完成「${escapeText(r.title)}」：${escapeText(r.summary || '')}`)
    for (const r of p.working) lines.push(`  - 进行中「${escapeText(r.title)}」（${escapeText(r.assigneeName)}，清单 ${r.checklist.done}/${r.checklist.total}，最后更新 ${hhmm(r.updatedAt)}）`)
  }
  lines.push('', '## 设备活动（按设备累计）')
  for (const device of view.devices ?? []) lines.push(`- ${escapeText(device.name)}：${device.minutes} 分钟，${device.windows} 个摘要窗。${device.refs.slice(-12).map(r => `[${r}]`).join(' ')}`)
  // The computer's history has its own section, so a busy day at the computer never pushes project events out of the timeline.
  const timeline = view.timeline.filter(e => e.kind !== 'activity'), computer = view.timeline.filter(e => e.kind === 'activity')
  lines.push('', '## 时间线')
  if (timeline.length === 0) lines.push('（没有）')
  for (const e of timeline.slice(-80)) lines.push(`- ${hhmm(e.at)} [${e.ref}] ${escapeText(e.projectName)}：${escapeText(e.text)}`)
  if (timeline.length > 80) lines.push(`（更早的 ${timeline.length - 80} 条省略）`)
  lines.push('', '## 电脑活动（每 10 分钟整理一次，是线索；依据可用 hub_source 核对）')
  if (computer.length === 0) lines.push('（没有）')
  for (const e of computer.slice(-60)) lines.push(`- ${hhmm(e.at)}–${hhmm(e.end)} [${e.ref}] ${escapeText(e.text)} 依据 ${e.refs.slice(0, 6).join(',')}`)
  if (computer.length > 60) lines.push(`（更早的 ${computer.length - 60} 段省略，可用 hub_search 按时间查）`)
  return lines.join('\n')
}
