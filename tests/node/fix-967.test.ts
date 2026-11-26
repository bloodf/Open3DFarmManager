import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  claimCommand,
  clearUncertainHolds,
  closeCommandJournal,
  finishCommand,
  markWriteStarted,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { provisionHalotPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedHalotControl } from '../../packages/connector/src/halot/control-driver.ts'
import {
  startHalotSimulator,
  HALOT_SIMULATOR_PASSWORD,
} from '../../packages/sim-tools/src/halot-simulator.ts'

const model = 'HALOT-MAGE PRO' as const
async function fixture(
  t: TestContext,
  stopWord: 'PRINT_END' | 'PRINT_STOP' | 'TEST_CANCELLED' = 'PRINT_END',
) {
  const sim = await startHalotSimulator({ stopWord })
  t.after(sim.close)
  sim.beginPrint('part.cxdlpv4')
  const dir = await mkdtemp(join(tmpdir(), 'fix-967-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const origin = `ws://127.0.0.1:${sim.port}`
  const passwordFile = join(dir, 'password.json')
  await writeFile(
    passwordFile,
    JSON.stringify({ origin, password: HALOT_SIMULATOR_PASSWORD }),
    { mode: 0o600 },
  )
  const scope = {
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'halot',
  }
  const local = {
    family: 'halot' as const,
    printerKey: 'halot',
    origin,
    passwordFile,
    simulated: true,
    expect: { model },
  }
  const binding = () => provisionHalotPrinter(scope, local)
  return { sim, binding, scope, dir }
}
async function open(
  t: TestContext,
  binding: ReturnType<Awaited<ReturnType<typeof fixture>>['binding']>,
  qualifications: Parameters<
    typeof openFixedHalotControl
  >[0]['halotQualifiedWrites'],
) {
  const signal = new AbortController().signal
  const control = openFixedHalotControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal,
    pollMs: 5,
    confirmTimeoutMs: 30,
    halotQualifiedWrites: qualifications,
  })
  t.after(control.close)
  await control.prepare()
  return { control, signal }
}
const all = [
  { model, operation: 'pause' as const },
  { model, operation: 'resume' as const },
  { model, operation: 'cancel' as const, cancelReached: ['TEST_CANCELLED'] },
]

test('a control instance sends at most one command', async (t) => {
  const { sim, binding: makeBinding } = await fixture(t)
  const binding = makeBinding()
  const { control, signal } = await open(t, binding, all)
  const request = { binding, signal, beforeSend: () => true }
  await control.driver.execute!('pause', {}, request)
  await assert.rejects(control.driver.execute!('resume', {}, request))
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
})

test('stop confirmation rejects another job even with a qualified stop word', async (t) => {
  const { sim, binding: makeBinding } = await fixture(t, 'TEST_CANCELLED')
  const binding = makeBinding()
  const { control, signal } = await open(t, binding, all)
  await assert.rejects(
    control.driver.execute!(
      'cancel',
      {},
      {
        binding,
        signal,
        beforeSend: () => {
          queueMicrotask(() => {
            sim.machine.filename = 'other.cxdlpv4'
          })
          return true
        },
      },
    ),
    /uncertain/,
  )
  assert.deepEqual(sim.writes(), ['PRINT_STOP'])
})

test('natural completion words never confirm cancel, even if configured', async (t) => {
  const { sim, binding: makeBinding } = await fixture(t)
  const binding = makeBinding()
  const { control, signal } = await open(t, binding, [
    {
      model,
      operation: 'cancel',
      cancelReached: ['PRINT_END', 'PRINT_GENERAL', 'PRINT_COMPLETE'],
    },
  ])
  await assert.rejects(
    control.driver.execute!(
      'cancel',
      {},
      { binding, signal, beforeSend: () => true },
    ),
    /uncertain/,
  )
  assert.deepEqual(sim.writes(), ['PRINT_STOP'])
})

test('resume refuses PRINT_STOP by default and honors model-specific states', async (t) => {
  const { sim, binding: makeBinding } = await fixture(t)
  sim.machine.printStatus = 'PRINT_STOP'
  const binding = makeBinding()
  const first = await open(t, binding, all)
  await assert.rejects(
    first.control.driver.execute!(
      'resume',
      {},
      { binding, signal: first.signal, beforeSend: () => true },
    ),
  )
  assert.deepEqual(sim.writes(), [])
  await first.control.close()
  const second = await open(t, binding, [
    { model, operation: 'resume', resumeFrom: ['PRINT_STOP'] },
  ])
  // The simulator uses PRINT_PAUSE for its pause state, so ignore the command and verify only the authorized send.
  sim.setFault('ignore')
  await assert.rejects(
    second.control.driver.execute!(
      'resume',
      {},
      { binding, signal: second.signal, beforeSend: () => true },
    ),
    /uncertain/,
  )
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
})

test('journal hold survives rebinding and only clear_hold releases writes', async (t) => {
  const { sim, binding: makeBinding, scope, dir } = await fixture(t)
  const journal = openCommandJournal({
    directory: dir,
    clock: () => Date.now(),
  })
  t.after(() => closeCommandJournal(journal))
  const ids = {
    farm_id: scope.farm_id,
    agent_id: scope.agent_id,
    assignment_id: scope.assignment_id,
    account_id: 'text_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
  }
  function claim(action: 'pause' | 'resume' | 'cancel' | 'clear_hold') {
    const now = Date.now()
    return claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id: randomUUID(),
        ...ids,
        action,
        args: {},
        issued_at: now,
        expires_at: now + 5000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey: 'halot',
      wireSha256: 'a'.repeat(64),
    })
  }
  const first = claim('pause')
  assert.ok(first.ok)
  const binding = makeBinding()
  const control = await open(t, binding, all)
  sim.setFault('ignore')
  await assert.rejects(
    control.control.driver.execute!(
      'pause',
      {},
      {
        binding,
        signal: control.signal,
        beforeSend: () => markWriteStarted(journal, first.receipt),
      },
    ),
    /uncertain/,
  )
  assert.ok(
    finishCommand(
      journal,
      first.receipt,
      'outcome-unknown',
      'state-unconfirmed',
    ),
  )
  await control.control.close()
  const rebound = makeBinding()
  assert.notEqual(binding, rebound)
  const reboundControl = await open(t, rebound, all)
  let consulted = false
  await assert.rejects(
    reboundControl.control.driver.execute!(
      'pause',
      {},
      {
        binding: rebound,
        signal: reboundControl.signal,
        beforeSend: () => {
          consulted = true
          const result = claim('pause')
          if (!result.ok) {
            assert.equal(result.reason, 'assignment-busy')
            return false
          }
          return markWriteStarted(journal, result.receipt)
        },
      },
    ),
  )
  assert.equal(consulted, true)
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
  await reboundControl.control.close()
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    const denied = claim(action)
    assert.deepEqual(denied, { ok: false, reason: 'assignment-busy' })
  }
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
  const clear = claim('clear_hold')
  assert.ok(clear.ok)
  assert.ok(markWriteStarted(journal, clear.receipt))
  assert.ok(clearUncertainHolds(journal, clear.receipt, 'admin'))
  assert.ok(finishCommand(journal, clear.receipt, 'applied', 'applied'))
  const after = claim('pause')
  assert.ok(after.ok)
  sim.setFault()
  const reopened = await open(t, binding, all)
  await reopened.control.driver.execute!(
    'pause',
    {},
    {
      binding,
      signal: reopened.signal,
      beforeSend: () => markWriteStarted(journal, after.receipt),
    },
  )
  assert.ok(finishCommand(journal, after.receipt, 'applied', 'applied'))
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE', 'PRINT_PAUSE'])
})
