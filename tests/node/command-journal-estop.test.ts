import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimCommand, closeCommandJournal, finishCommand, openCommandJournal } from '../../packages/connector/src/control/command-journal.ts'

test('emergency stop bypasses an unresolved command without releasing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-estop-'))
  const journal = openCommandJournal({ directory, clock: () => 1000 })
  const scope = { farm_id: randomUUID(), agent_id: randomUUID(), account_id: 'text_account', key_id: randomUUID(), transport_id: randomUUID(), capability_id: randomUUID(), assignment_id: randomUUID() }
  const claim = (action: 'pause' | 'emergency_stop') => claimCommand(journal, {
    command: { v: 2, purpose: action === 'pause' ? 'printer-pause' : 'printer-control', cmd_id: randomUUID(), ...scope, action, args: {}, issued_at: 1000, expires_at: 6000, nonce: randomBytes(16).toString('base64url'), sig: 'A'.repeat(86) },
    printerKey: 'printer', wireSha256: 'a'.repeat(64),
  })
  try {
    assert.ok(claim('pause').ok)
    assert.deepEqual(claim('pause'), { ok: false, reason: 'assignment-busy' })
    const stop = claim('emergency_stop')
    assert.ok(stop.ok, JSON.stringify(stop))
    assert.ok(finishCommand(journal, stop.receipt, 'not-sent', 'not-sent'))
    assert.deepEqual(claim('pause'), { ok: false, reason: 'assignment-busy' })
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
})
