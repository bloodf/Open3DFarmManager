import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimCommand,
  closeCommandJournal,
  finishCommand,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'

test('emergency stop bypasses an unresolved command without releasing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-estop-'))
  const journal = openCommandJournal({ directory, clock: () => 1000 })
  const scope = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'text_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const claim = (action: 'pause' | 'emergency_stop') =>
    claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id: randomUUID(),
        ...scope,
        action,
        args: {},
        issued_at: 1000,
        expires_at: 6000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey: 'printer',
      wireSha256: 'a'.repeat(64),
    })
  try {
    assert.ok(claim('pause').ok)
    assert.deepEqual(claim('pause'), { ok: false, reason: 'assignment-busy' })
    const stop = claim('emergency_stop')
    assert.ok(stop.ok, stop.ok ? undefined : stop.reason)
    assert.ok(finishCommand(journal, stop.receipt, 'not-sent', 'not-sent'))
    assert.deepEqual(claim('pause'), { ok: false, reason: 'assignment-busy' })
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rate saturation and forward clock jumps do not block emergency stop', () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-estop-'))
  let now = 1000
  const journal = openCommandJournal({ directory, clock: () => now })
  const scope = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'text_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const claim = (action: 'pause' | 'emergency_stop') =>
    claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id: randomUUID(),
        ...scope,
        action,
        args: {},
        issued_at: 1000,
        expires_at: 6000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey: 'printer',
      wireSha256: 'a'.repeat(64),
    })
  try {
    for (let i = 0; i < 10; i++) {
      const result = claim('pause')
      assert.ok(result.ok)
      assert.ok(finishCommand(journal, result.receipt, 'not-sent', 'not-sent'))
    }
    assert.deepEqual(claim('pause'), { ok: false, reason: 'rate-limited' })
    now = 100000
    assert.equal(claim('pause').ok, false)
    now = 1000
    const stop = claim('emergency_stop')
    assert.ok(stop.ok, stop.ok ? undefined : stop.reason)
    assert.ok(finishCommand(journal, stop.receipt, 'not-sent', 'not-sent'))
    assert.deepEqual(claim('pause'), { ok: false, reason: 'rate-limited' })
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reopening reconciles an unfinished foreign writer and preserves exclusion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-estop-'))
  let journal = openCommandJournal({ directory, clock: () => 1000 })
  const scope = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'text_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const command = (action: 'pause' | 'emergency_stop') => ({
    v: 2 as const,
    purpose:
      action === 'pause'
        ? ('printer-pause' as const)
        : ('printer-control' as const),
    cmd_id: randomUUID(),
    ...scope,
    action,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
    sig: 'A'.repeat(86),
  })
  const claim = (value: ReturnType<typeof command>) =>
    claimCommand(journal, {
      command: value,
      printerKey: 'printer',
      wireSha256: 'a'.repeat(64),
    })
  try {
    assert.ok(claim(command('pause')).ok)
    closeCommandJournal(journal)
    journal = openCommandJournal({ directory, clock: () => 1000 })
    assert.deepEqual(claim(command('pause')), {
      ok: false,
      reason: 'assignment-busy',
    })
    assert.ok(claim(command('emergency_stop')).ok)
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
})
