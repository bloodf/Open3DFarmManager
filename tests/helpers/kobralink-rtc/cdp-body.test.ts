import assert from 'node:assert/strict'
import test from 'node:test'
import { uniqueMatch } from './cdp-body.ts'

test('attributes a response despite observed cross-session wall-clock drift', () => {
  const captured = { startMs: 1794878380622.267, claimed: false }
  const playwrightStartMs = 1794878380622.216
  assert.equal(uniqueMatch([captured], playwrightStartMs), captured)
})

test('clock drift allowance still refuses ambiguous, distant and claimed requests', () => {
  const first = { startMs: 1000, claimed: false }
  const adjacent = { startMs: 1000.08, claimed: false }
  assert.equal(uniqueMatch([first, adjacent], 1000.04), 'ambiguous')
  assert.equal(uniqueMatch([first], 1000.15), null)
  assert.equal(uniqueMatch([{ ...first, claimed: true }], 1000), null)
})
