// #947: restart holds are bounded, and an operator can clear a stuck one.
// Journal and shipped dispatcher against a fake driver: nothing here contacts a
// printer.
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimCommand,
  clearUncertainHolds,
  closeCommandJournal,
  finishCommand,
  hasReadyReleasableHold,
  hasUncertainHold,
  HOLD_AUDIT_FILE,
  markWriteStarted,
  openCommandJournal,
  readCommandOutcome,
  releaseHoldsOnReady,
} from '../../packages/connector/src/control/command-journal.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  argsOf,
  dispatcherFixture,
  held,
} from '../helpers/restart-hold-dispatch.ts'

const HOLDS: [string, ExtendedControlAction[]][] = [
  ['a firmware restart', ['firmware_restart']],
  [
    'an emergency stop during a restart',
    ['firmware_restart', 'emergency_stop'],
  ],
  ['a config save with restart lost after send', ['config_write']],
]

for (const [name, commands] of HOLDS) {
  test(`pause after ${name}: released once the printer reports ready`, async (t) => {
    const { f, c } = await held(t, commands)
    // Too soon: a printer that has not begun restarting still reports ready.
    assert.equal(await c.send('pause'), 'rejected:busy')
    c.d.advance(5000)
    f.printer.ready = false
    assert.equal(await c.send('pause'), 'rejected:busy')
    f.printer.ready = true
    assert.equal(await c.send('pause'), 'applied:applied')
    assert.deepEqual(f.sent, [...commands, 'pause'])
  })

  test(`pause after ${name}: released by time in a running Connector`, async (t) => {
    const { f, c } = await held(t, commands)
    c.d.advance(50_000)
    await c.d.readmit()
    // No ready evidence at the pre-claim read, so only time can release.
    f.printer.notReadyReads = 1
    assert.equal(await c.send('pause'), 'rejected:busy')
    c.d.advance(10_000)
    f.printer.notReadyReads = 1
    assert.equal(await c.send('pause'), 'applied:applied')
    assert.deepEqual(f.sent, [...commands, 'pause'])
  })

  test(`pause after ${name}: released by a Connector restart`, async (t) => {
    const { f, c } = await held(t, commands)
    c.d.close()
    const after = await f.open(2000)
    assert.equal(await after.send('pause'), 'applied:applied')
    assert.deepEqual(f.sent, [...commands, 'pause'])
  })
}

test('emergency stop stays available during a lost config save', async (t) => {
  const { f, c } = await held(t, ['config_write'])
  assert.equal(await c.send('pause'), 'rejected:busy')
  assert.match(await c.send('emergency_stop'), /^(applied|outcome-unknown):/)
  assert.deepEqual(f.sent, ['config_write', 'emergency_stop'])
})

test('emergency stop preempts the readiness read of another command', async (t) => {
  const { f, c } = await held(t, ['firmware_restart'])
  c.d.advance(5000)
  f.printer.hang = true
  const reading = new Promise<void>((resolve) => {
    f.printer.reading = resolve
  })
  const pause = c.send('pause')
  await reading
  assert.match(await c.send('emergency_stop'), /^(applied|outcome-unknown):/)
  assert.equal(await pause, 'rejected:busy')
  assert.deepEqual(f.sent, ['firmware_restart', 'emergency_stop'])
})

for (const stalledStep of ['holdPrepareOpen', 'holdCloseOpen'] as const) {
  test(`emergency stop returns busy when the readiness probe stalls in ${stalledStep}`, async (t) => {
    const { f, c } = await held(t, ['firmware_restart'])
    c.d.advance(5000)
    f.printer.hang = true
    const stalled = Promise.withResolvers<void>()
    f.printer[stalledStep] = stalled.promise
    const reading = Promise.withResolvers<void>()
    f.printer.reading = reading.resolve
    const pause = c.send('pause')
    await reading.promise
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      const wire = await c.wire('emergency_stop')
      const stop = await Promise.race([
        c.d.dispatch(wire),
        new Promise<'still pending'>((resolve) => {
          watchdog = setTimeout(() => resolve('still pending'), 750)
        }),
      ])
      assert.notEqual(typeof stop, 'string', 'still pending')
      assert.equal(
        typeof stop === 'string' ? stop : `${stop.kind}:${stop.reason}`,
        'rejected:busy',
      )
      assert.deepEqual(stop, {
        kind: 'rejected',
        reason: 'busy',
        message:
          'A parada de emergência não foi enviada porque a verificação da impressora demorou demais.',
      })
      assert.deepEqual(f.sent, ['firmware_restart'])
    } finally {
      clearTimeout(watchdog)
      stalled.resolve()
      await pause
    }
  })
}

test('an emergency stop outside a restart holds until the operator clears it', async (t) => {
  const f = await dispatcherFixture(t)
  f.printer.state = 'printing'
  const c = await f.open(1000)
  assert.equal(
    await c.send('emergency_stop'),
    'outcome-unknown:state-unconfirmed',
  )
  c.d.close()

  const after = await f.open(2000)
  // Neither a Connector restart, a ready printer nor time releases it.
  assert.equal(await after.send('pause'), 'rejected:busy')
  after.d.advance(60_000)
  await after.d.readmit()
  assert.equal(await after.send('pause'), 'rejected:busy')
  const reads = f.printer.reads
  // The operator checked a printer that may be in any state.
  f.printer.ready = false
  assert.equal(await after.send('clear_hold'), 'applied:applied')
  assert.equal(f.printer.reads, reads, 'the clear never reads the printer')
  assert.deepEqual(f.sent, ['emergency_stop'], 'nothing is sent or retried')
  const [entry, ...rest] = f.audit()
  assert.equal(rest.length, 0)
  assert.equal(entry.event, 'hold-cleared')
  assert.equal(entry.role, 'admin')
  assert.equal(entry.account_id, f.authority.ids.account_id)
  assert.equal(entry.key_id, f.authority.ids.key_id)
  assert.equal(entry.printer_key, f.authority.printerKey)
  assert.deepEqual(
    entry.cleared.map((row: { action: string }) => row.action),
    ['emergency_stop'],
  )
  f.printer.ready = true
  assert.equal(await after.send('pause'), 'applied:applied')
  assert.deepEqual(f.sent, ['emergency_stop', 'pause'])
})

test('an operator cannot clear a hold', async (t) => {
  const f = await dispatcherFixture(t, 'operator')
  const c = await f.open(1000)
  assert.match(await c.send('emergency_stop'), /^outcome-unknown:/)
  // Even a capability that somehow listed the action fails the role rule.
  const result = await c.send('clear_hold').catch(() => 'refused')
  assert.match(result, /^(rejected:scope|refused)$/)
  f.printer.state = 'printing'
  assert.equal(await c.send('pause'), 'rejected:busy')
})

test('a clear that cannot be audited keeps the hold', async (t) => {
  const f = await dispatcherFixture(t, 'owner')
  f.printer.state = 'printing'
  const c = await f.open(1000)
  assert.match(await c.send('emergency_stop'), /^outcome-unknown:/)
  mkdirSync(join(f.directory, HOLD_AUDIT_FILE))
  assert.equal(await c.send('clear_hold'), 'not-sent:storage')
  assert.equal(await c.send('pause'), 'rejected:busy')
  assert.match(await c.send('emergency_stop'), /^(applied|outcome-unknown):/)
})

// --- Journal rules ------------------------------------------------------------

const IDS = {
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  account_id: 'text_account',
  key_id: randomUUID(),
  transport_id: randomUUID(),
  capability_id: randomUUID(),
  assignment_id: randomUUID(),
}
const SCOPE = {
  assignmentId: IDS.assignment_id,
  farmId: IDS.farm_id,
  printerKey: 'printer',
}

function journalFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-947-journal-'))
  let now = 100_000
  const journal = openCommandJournal({ directory, clock: () => now })
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  function claim(action: ExtendedControlAction) {
    const cmd_id = randomUUID()
    const result = claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id,
        ...IDS,
        action,
        args: argsOf(action),
        issued_at: now,
        expires_at: now + 5000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey: 'printer',
      wireSha256: 'a'.repeat(64),
    })
    return { cmd_id, result }
  }
  function sent(action: ExtendedControlAction) {
    const { cmd_id, result } = claim(action)
    assert.ok(result.ok, action)
    assert.ok(markWriteStarted(journal, result.receipt))
    return { cmd_id, receipt: result.receipt }
  }
  const unknown = (receipt: ReturnType<typeof sent>['receipt']) =>
    assert.ok(finishCommand(journal, receipt, 'outcome-unknown', 'rpc-unknown'))
  return {
    journal,
    claim,
    sent,
    unknown,
    lost(action: ExtendedControlAction) {
      const command = sent(action)
      unknown(command.receipt)
      return command.cmd_id
    },
    busy() {
      const { result } = claim('resume')
      if (result.ok) {
        finishCommand(journal, result.receipt, 'not-sent', 'guard-denied')
        return false
      }
      assert.equal(result.reason, 'assignment-busy')
      return true
    },
    advance(ms: number) {
      now += ms
    },
  }
}

test('journal: an emergency stop during an in-flight restart is released', (t) => {
  const f = journalFixture(t)
  const restart = f.sent('firmware_restart')
  const stop = f.lost('emergency_stop')
  f.unknown(restart.receipt)
  f.advance(60_000)
  assert.equal(f.busy(), false)
  assert.equal(readCommandOutcome(f.journal, stop)?.status, 'outcome-unknown')
})

test('journal: an emergency stop after the restart window stays held', (t) => {
  const f = journalFixture(t)
  f.lost('firmware_restart')
  f.advance(60_000)
  f.lost('emergency_stop')
  f.advance(120_000)
  assert.equal(f.busy(), true)
})

test('journal: a restart refused before the send explains no emergency stop', (t) => {
  const f = journalFixture(t)
  const { result } = f.claim('firmware_restart')
  assert.ok(result.ok)
  assert.ok(
    finishCommand(f.journal, result.receipt, 'not-sent', 'guard-denied'),
  )
  f.lost('emergency_stop')
  f.advance(120_000)
  assert.equal(f.busy(), true)
})

test('journal: the emergency stop release outlives the restart row retention', (t) => {
  const f = journalFixture(t)
  f.lost('firmware_restart')
  f.lost('emergency_stop')
  f.advance(601_000)
  assert.equal(f.busy(), false)
})

test('journal: ready evidence releases only settled restart holds', (t) => {
  const f = journalFixture(t)
  f.lost('config_write')
  assert.equal(hasReadyReleasableHold(f.journal, SCOPE), false)
  f.advance(5000)
  assert.equal(
    hasReadyReleasableHold(f.journal, {
      ...SCOPE,
      assignmentId: randomUUID(),
      printerKey: 'other',
    }),
    false,
  )
  assert.equal(hasReadyReleasableHold(f.journal, SCOPE), true)
  releaseHoldsOnReady(f.journal, SCOPE)
  assert.equal(f.busy(), false)
  f.lost('pause')
  f.advance(5000)
  assert.equal(hasReadyReleasableHold(f.journal, SCOPE), false)
  releaseHoldsOnReady(f.journal, SCOPE)
  assert.equal(f.busy(), true)
})

test('journal: a clear is refused while a command is in flight', (t) => {
  const f = journalFixture(t)
  f.sent('pause')
  assert.deepEqual(f.claim('clear_hold').result, {
    ok: false,
    reason: 'assignment-busy',
  })
})

test('journal: only a claimed clear_hold can clear', (t) => {
  const f = journalFixture(t)
  f.lost('pause')
  const stop = f.sent('emergency_stop')
  assert.equal(clearUncertainHolds(f.journal, stop.receipt, 'admin'), false)
  assert.equal(f.busy(), true)
})

test('journal: clear_hold is offered only while a command is unconfirmed', (t) => {
  const f = journalFixture(t)
  assert.equal(hasUncertainHold(f.journal, SCOPE), false)
  f.lost('firmware_restart')
  assert.equal(hasUncertainHold(f.journal, SCOPE), true)
  f.advance(60_000)
  assert.equal(hasUncertainHold(f.journal, SCOPE), false)
})
