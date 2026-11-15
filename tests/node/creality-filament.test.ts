import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCrealityFilamentCommand } from '../../packages/connector/src/creality/filament.ts'
import {
  buildCrealityCommand,
  supportedCrealityActions,
} from '../../packages/connector/src/creality/commands.ts'

test('undocumented filament operations cannot produce stock WebSocket frames', () => {
  for (const action of ['load_filament', 'unload_filament', 'feed_cfs_slot']) {
    assert.equal(supportedCrealityActions().includes(action), false)
    assert.throws(
      () => buildCrealityFilamentCommand(action),
      /Unsupported Creality filament action/,
    )
    assert.throws(
      () => buildCrealityCommand(action),
      /Unsupported Creality action/,
    )
  }
})
