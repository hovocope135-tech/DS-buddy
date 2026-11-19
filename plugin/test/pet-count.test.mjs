import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

test('the waiting pet is the figure alone, like Codex\'s pets: no bubble or count over its head, whatever waits', () => {
  const pic = count => JSON.stringify(client.miraScene('waiting', null, count))
  assert.equal(pic(0), pic(3)); assert.equal(pic(3), pic(42))
  const top = Math.min(...client.miraScene('waiting', null).flatMap(frame => frame.map(([, y]) => y)))
  assert.ok(top >= 8, 'nothing drawn above the figure\'s head')
  // Other scenes ignore the count.
  assert.equal(JSON.stringify(client.miraScene('working', null, 3)), JSON.stringify(client.miraScene('working', null)))
})

test('a centred scene is shifted so what is drawn sits in the middle; a template shows as picked only when the figure matches it', () => {
  const centre = state => {
    const frames = client.miraScene(state, null)
    let lo = 32, hi = 0
    for (const frame of frames) for (const [x, , w] of frame) { lo = Math.min(lo, x); hi = Math.max(hi, x + w) }
    return (lo + hi) / 2 - client.sceneShift(frames)
  }
  for (const state of ['working', 'done', 'waiting', 'sleeping']) assert.ok(Math.abs(centre(state) - 16) <= 0.5, state)
  assert.ok(client.sceneShift(client.miraScene('waiting', null)) > 0, 'the waiting scene leans right, so it moves left')
  const owl = client.LOOK_TEMPLATES.find(t => t.id === 'owl')
  assert.equal(client.isTemplate({ ...owl, template: null }, owl), true, 'same figure counts as the template')
  assert.equal(client.isTemplate({ ...owl, template: null, color: 'green' }, owl), false)
  for (const k of ['shape', 'eyes', 'accessory']) assert.equal(client.isTemplate({ ...owl, template: null, [k]: 'none' }, owl), false, k)
  assert.equal(client.isTemplate({ template: 'owl' }, owl), true)
})

test('the layers that float above the page (the pet and the look studio) sit inside the colour scope, so their borders and hovers resolve', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const rule = source.split('\n').find(line => line.includes('{--mp4-fg:'))
  assert.ok(rule, 'the scope rule exists')
  const roots = rule.slice(0, rule.indexOf('{')).split(',')
  for (const root of ['.mp4-ball-wrap', '.mp4-studio-veil']) assert.ok(roots.includes(root), root)
})

test('no floating pet (2026-11-18 night): nothing floats in the corner; the pixel figure is the assistant avatar, in its conversation and the studio', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /"mira-projects: floating ball"/)
  assert.doesNotMatch(source, /"桌宠"/)
  assert.match(source, /"mira-projects: assistant avatar in its conversation"/)
  assert.doesNotMatch(source, /"conversation\.session\.header\.lineage"/, "a single-occupant spot DSH's sub-agent plugin already holds: taking it stops the whole plugin loading")
  assert.match(source, /h\(MiraPortrait, \{ look: draft, size: 112 \}\)/)
  assert.match(source, /"mira-projects: summon key"/)
})

test('the figure is the first pixel version (11-13, the owner\'s pick 2026-11-18): the body wears the picked colour as is, a darker outline, dark eyes', () => {
  const fills = { yellow: '#ffc53d', orange: '#f76b15', red: '#e5484d', pink: '#d6409f', purple: '#8e4ec6', blue: '#0090ff', teal: '#12a594', green: '#30a46c', gray: '#8d8d8d' }
  const lum = hex => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) }
  for (const shape of ['mochi', 'round', 'block']) for (const [color, fill] of Object.entries(fills)) {
    const cells = client.lookCells({ color, shape, eyes: 'dot', accessory: 'none' }, 'ask')
    const body = cells.get(6 * 14 + 6), eye = cells.get(7 * 14 + 4), rim = cells.get(11 * 14 + 6)
    assert.equal(body, fill, `${shape}/${color}: the body is the picked colour`)
    assert.equal(eye, '#202020', `${shape}/${color}: dark eyes`)
    assert.ok(lum(rim) < lum(body) - 20, `${shape}/${color}: the outline ${rim} is darker than the body ${body}`)
  }
})

test('the board reads in two sizes (owner 2026-11-19): section heads 16, everything else 14 whether gray or black; leading icons all 16', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /head\("项目进展", /)
  assert.doesNotMatch(source, /"最近在动"/)
  const css = source.split('\n').filter(line => /^\.mp4-(bd-|kanban-rows)/.test(line)).join('\n')
  const sizes = new Set([...css.matchAll(/font-size:(\d+)px/g)].map(m => +m[1]))
  assert.deepEqual([...sizes].sort(), [14, 16])
  assert.match(css, /\.mp4-bd-head>b\{font-size:16px/)
  const board = source.slice(source.indexOf('function MiraBoard('), source.indexOf('// ---------------------------------------------------------------- 技能自迭代'))
  for (const m of board.matchAll(/h\((ProjectMark|StatusIcon), \{[^}]*size: (\d+)/g)) assert.equal(m[2], '16', m[0])
  assert.match(board, /sourceIcon\(n, 16\)/)
  assert.doesNotMatch(board, /没有新动静|mp4-bd-chip/, 'quiet projects are not on the board')
  const render = source.slice(source.indexOf('if (today.board) return'), source.indexOf('const blocks = [', source.indexOf('if (today.board) return')))
  assert.doesNotMatch(render, /SkillRows/, 'nothing under the board')
})

test('「读了项目里的新消息」 opens to what was read (owner 2026-11-19): who and where, then the words, no ids or markup', () => {
  const out = [
    '<item seq="12" kind="message" id="m_1" where="群聊" from="用户" trust="principal" nonce="n">准备好 Tacit 1.0 发布的公众号文章 &lt;zh-v1&gt; &amp; DSH 那篇<shared-files>[{"file_id":"f_1"}]</shared-files></item>',
    '<item seq="13" kind="thread_opened" thread="t_9" title="备好发布公众号文章" assignee="执行者" priority="P2" from="项目助理" trust="relay" nonce="n">\n  <brief>把 zh-v1、zh-v2 改到可发布</brief>\n  <note></note>\n</item>',
    '<item seq="14" kind="message" id="m_2" where="线程「出二面动效题」" from="执行者" trust="member" nonce="n">做好了</item>',
    '<item seq="15" kind="message" id="m_3" where="线程 t_gone" from="执行者" trust="member" nonce="n">旧任务的话</item>',
    '<item seq="16" kind="decision_requested" decision="d_1" thread="t_9" title="选外壳" trust="relay" nonce="n">用哪种外壳？ 选项：推荐 圆 / 方</item>',
    '<item seq="17" kind="thread_state" thread="t_9" title="备好发布公众号文章" state="blocked" from="执行者" trust="system" nonce="n">线程「备好发布公众号文章」变为等你。摘要：在等稿子位置</item>',
    '未读已全部读完。',
  ].join('\n')
  const plain = v => JSON.parse(JSON.stringify(v))
  assert.deepEqual(plain(client.inboxItems(out)), [
    { who: '你，项目对话', what: '准备好 Tacit 1.0 发布的公众号文章 <zh-v1> & DSH 那篇' },
    { who: '新任务「备好发布公众号文章」', what: '把 zh-v1、zh-v2 改到可发布' },
    { who: '执行者，任务「出二面动效题」', what: '做好了' },
    { who: '执行者，一个任务', what: '旧任务的话' },
    { who: '等你拍板「选外壳」', what: '用哪种外壳？ 选项：推荐 圆 / 方' },
    { who: '任务状态', what: '任务「备好发布公众号文章」变为等你。摘要：在等稿子位置' },
  ])
  assert.equal(client.inboxItems('收件箱没有未读条目。').length, 0)
})

test('DESIGN.md direction 2 (owner 2026-11-19): the three core tabs share one scope, white with hairline cards; the studio shows every option as a picture with one selected style', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const view of ['inbox', 'time', 'tree']) assert.match(source, new RegExp(`h\\(MiraOverview, \\{ view: "${view}" \\}\\), "mp4-core"`), view)
  assert.doesNotMatch(source, /--mp4-canvas|mp4-tabpane-canvas/, 'no grey canvas')
  assert.match(source, /:root\{--mp4-t-line:[^}]*--mp4-r-card:12px;--mp4-r-ctl:8px;--mp4-r-mark:4px\}/)
  assert.match(source, /\.mp4-bd-proj,\.mp4-bd-card\{border:\.5px solid var\(--mp4-t-border\);border-radius:var\(--mp4-r-card\)\}/)
  assert.match(source, /\.mp4-core \.mp4-tree-project\{border:\.5px solid var\(--mp4-t-border\)/)
  assert.match(source, /\.mp4-core \.mp4-tl-list\{border:\.5px solid var\(--mp4-t-border\)/)
  assert.match(source, /const opt = \(on, label, look, onClick, key, big\) => h\("button", \{ key, type: "button", className: "mp4-pick"/)
  assert.match(source, /\.mp4-pick-on,\.mp4-pick-on:hover\{border-color:transparent;box-shadow:0 0 0 1\.5px var\(--mp4-fg\)\}/)
  assert.doesNotMatch(source.slice(source.indexOf('function LookStudio('), source.indexOf('const titles = ["形象", "性格与呼出"];')), /mp4-chips" \}, Object\.keys\(LOOK_LABELS\.(shape|eyes|accessory)\)/, 'body, eyes and accessories are pictures, not text pills')
})

test('DESIGN.md everywhere (owner 2026-11-20): every rule in the stylesheet uses type 14 or 16 on a 24 line, radius 12/8/4, spacing in steps of 4', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('const CSS = `') + 13, css = src.slice(start, src.indexOf('\n`;', start))
  const bad = []
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const where = sel.trim().split('\n').at(-1).slice(0, 60)
    for (const [, v] of body.matchAll(/font-size:([0-9.]+)px/g)) if (!['14', '16'].includes(v)) bad.push(`${where} font-size ${v}`)
    for (const [, v] of body.matchAll(/line-height:([0-9.]+)px/g)) if (Number(v) < 30 && v !== '24') bad.push(`${where} line-height ${v}`)
    for (const [, v] of body.matchAll(/border-radius:([^;}]+)/g)) for (const [, n] of v.matchAll(/([0-9.]+)px/g)) if (!['0', '4', '8', '12', '999'].includes(n)) bad.push(`${where} radius ${n}`)
    for (const m of body.matchAll(/(?<![-a-z])(?:padding|margin)(?:-[a-z-]+)?:([^;}]+)|(?<![-a-z])(?:row-|column-)?gap:([^;}]+)/g)) {
      const val = m[1] || m[2] || ''
      if (/calc|var\(/.test(val)) continue
      for (const [, n] of val.matchAll(/(-?[0-9.]+)px/g)) if (Number(n) % 4) bad.push(`${where} spacing ${n}`)
    }
  }
  assert.deepEqual(bad, [])
  assert.ok(!/让 Mira/.test(src), 'buttons name the assistant, not the old product name')
  assert.match(css, /--mp4-hair2:var\(--mp4-t-border\)/)
})
