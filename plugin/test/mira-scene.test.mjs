import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

test('each of Mira\'s four scenes is two different frames inside the 32 × 24 grid, and no two scenes look alike', () => {
  const seen = new Set()
  for (const state of ['working', 'done', 'waiting', 'sleeping']) {
    const frames = client.miraScene(state, '#ffc53d')
    assert.equal(frames.length, 2)
    for (const frame of frames) {
      assert.ok(frame.length > 20, state)
      for (const [x, y, w, color] of frame) {
        assert.ok(x >= 0 && y >= 0 && y < 24 && w >= 1 && x + w <= 32, `${state} ${x},${y},${w}`)
        assert.equal(typeof color, 'string')
        assert.ok(!color.includes('undefined'), `${state} has a colour missing from the palette`)
      }
    }
    const [a, b] = frames.map(f => JSON.stringify(f))
    assert.notEqual(a, b, `${state} needs two different frames`)
    assert.ok(!seen.has(a), `${state} looks like another scene`)
    seen.add(a)
  }
})

test('the workspace scene celebrates a fresh finish for three minutes, then shows work, then what waits, then sleep', () => {
  const now = 1_000_000_000
  const running = { state: 'in_progress', experience: { execution: { active: true } } }
  const waitingOld = { state: 'review_ready', updatedAt: now - 10 * 60e3 }
  const fresh = { state: 'review_ready', updatedAt: now - 60e3 }
  assert.equal(client.workspaceScene([fresh, running], false, now).state, 'done')
  assert.equal(client.workspaceScene([waitingOld, running, running], false, now).title, '2 项进行中')
  assert.equal(client.workspaceScene([waitingOld], true, now).state, 'working')
  assert.equal(client.workspaceScene([waitingOld], false, now).title, '1 项待处理')
  assert.equal(client.workspaceScene([{ ...fresh, resolved: true }], false, now).state, 'sleeping')
  assert.equal(client.workspaceScene([], false, now).state, 'sleeping')
  const asking = { state: 'blocked', updatedAt: now - 30 * 60e3 }
  const first = client.workspaceScene([fresh, asking, running], true, now)
  assert.equal(first.state, 'waiting', 'a question for the owner outranks a fresh finish and running work')
  assert.equal(first.title, '1 项等你拍板')
})
