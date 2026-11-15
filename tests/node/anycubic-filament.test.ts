import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAnycubicFilamentCommand } from '../../packages/connector/src/anycubic/filament.ts'

test('ACE feed and unload are unsupported without a documented LAN request', () => {
  for (const action of ['load_filament', 'unload_filament'] as const) {
    assert.throws(() => buildAnycubicFilamentCommand(action, 0), /unsupported/)
  }
})
