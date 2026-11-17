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

test('the look studio, which floats above the page, sits inside the colour scope, so its borders and hovers resolve', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const rule = source.split('\n').find(line => line.includes('{--mp4-fg:'))
  assert.ok(rule, 'the scope rule exists')
  const roots = rule.slice(0, rule.indexOf('{')).split(',')
  assert.ok(roots.includes('.mp4-studio-veil'))
})

test('no desktop pet in the first release: nothing floats in the corner, no pet setting, the summon key still opens the assistant', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const gone of ['mira-ball', 'mp4-ball', 'MiraBall', '桌宠']) assert.ok(!source.includes(gone), gone)
  assert.match(source, /"mira-projects: summon key"/)
})

test('every look has a pale face window on a softer body: the face is lighter than the body, the eyes darker than the face, no ink outline', () => {
  const lum = hex => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) }
  for (const shape of ['mochi', 'round', 'block']) for (const color of ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green', 'gray']) {
    const cells = client.lookCells({ color, shape, eyes: 'dot', accessory: 'none' }, 'ask')
    const face = cells.get(9 * 14 + 5), body = cells.get(4 * 14 + 6), eye = cells.get(7 * 14 + 4), rim = cells.get(11 * 14 + 6)
    assert.ok(face && body && eye && rim, `${shape}/${color} draws face, body, eye and rim`)
    assert.ok(lum(face) > lum(body) + 20, `${shape}/${color}: face ${face} lighter than body ${body}`)
    assert.ok(lum(eye) < lum(face) - 120, `${shape}/${color}: eye ${eye} reads on the face ${face}`)
    assert.ok(lum(rim) > 40, `${shape}/${color}: the rim ${rim} is a shade of the body, not ink`)
  }
})
