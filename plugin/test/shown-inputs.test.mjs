import test from 'node:test'
import assert from 'node:assert/strict'
import { shownInputs } from '../lib/http.js'

test('files a task read show relative to its folder and never the machine user name', () => {
  const home = '/home/someone', cwd = home + '/.local/state/x/_folders/p_1'
  assert.deepEqual(shownInputs([
    'interview.md', cwd + '/前端招聘/scorecard.md', home + '/notes/a.md', '/tmp/x.txt', cwd + '/前端招聘/scorecard.md',
  ], [null, cwd + '/'], home), ['interview.md', '前端招聘/scorecard.md', '~/notes/a.md', '/tmp/x.txt'])
})
