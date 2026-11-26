// Phrozen writes in the Connector runtime: gated on a qualified pair, refused
// before the write with DriverRefusalError, and sent once when permitted.
// Loopback simulator only: nothing here reaches a physical printer.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import { openFixedPhrozenControl } from '../../packages/connector/src/phrozen/control-driver.ts'
import { supportsPhrozenUpload } from '../../packages/connector/src/phrozen/upload.ts'
import {
  provisionPhrozenPrinter,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import {
  PHROZEN_QUALIFIED_WRITES,
  type PhrozenQualification,
} from '../../packages/connector/src/phrozen/qualification.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import fixture from '../fixtures/phrozen/synthetic-revo-14k-v153.json' with { type: 'json' }

const MODEL = 'Sonic Mighty Revo 14K'
const QUALIFIED: PhrozenQualification[] = [
  { model: MODEL, firmwareVersion: 'V153' },
]
const WRITES = [128, 129, 130, 131, 386]
const OFFERED = ['pause', 'resume', 'cancel', 'start_print']

async function printer(t: TestContext) {
  const sim = await startPhrozenSimulator(structuredClone(fixture))
  t.after(sim.close)
  sim.reset()
  sim.beginPrint('part.ctb')
  const scope = {
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'revo',
  }
  const local = {
    family: 'phrozen' as const,
    printerKey: 'revo',
    origin: `ws://127.0.0.1:${sim.wsPort}`,
    discoveryPort: sim.udpPort,
    simulated: true,
    expect: {
      id: fixture.Id,
      board: fixture.Data.MainboardID,
      model: MODEL as typeof MODEL,
      firmware: 'V153' as const,
    },
  }
  const binding = provisionPhrozenPrinter(scope, local)
  const writes = () => sim.commands.filter((cmd) => WRITES.includes(cmd))
  return { sim, scope, local, binding, writes }
}

const router = (qualified?: PhrozenQualification[]) =>
  createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: () => true,
    ...(qualified ? { phrozenQualifiedWrites: qualified } : {}),
  })

async function attempt(
  routes: ReturnType<typeof router>,
  binding: PrinterBinding,
  action: 'pause' | 'start_print',
  beforeSend: () => boolean,
) {
  const signal = new AbortController().signal
  await routes.prepare({ binding, signal })
  try {
    return await routes.execute(
      action,
      action === 'start_print' ? { file: 'part.ctb' } : {},
      { binding, signal, beforeSend },
    )
  } finally {
    await routes.closeAttempt(binding)
  }
}

const refusal = (reason: DriverRefusalError['refusal']) => (error: unknown) =>
  error instanceof DriverRefusalError && error.refusal === reason

test('the shipped qualification list is empty: nothing is offered or sent', async (t) => {
  assert.deepEqual(PHROZEN_QUALIFIED_WRITES, [])
  const { binding, writes } = await printer(t)
  for (const qualified of [
    undefined,
    [{ model: MODEL, firmwareVersion: 'V138' }],
    [{ model: 'Sonic Mighty Revo 16K', firmwareVersion: 'V153' }],
  ]) {
    const routes = router(qualified)
    assert.deepEqual(routes.controls(binding), [])
    assert.deepEqual(await routes.detect(binding), [])
    assert.match(routes.startUnavailableMessage!(binding)!, /qualificados/)
    await assert.rejects(
      attempt(routes, binding, 'pause', () => true),
      refusal('unsupported-action'),
    )
  }
  assert.deepEqual(router(QUALIFIED).controls(binding), OFFERED)
  assert.deepEqual(writes(), [])
})

test('other models cannot be provisioned for writes', async (t) => {
  const { scope, local } = await printer(t)
  for (const model of [
    'Sonic Mighty Revo 16K',
    'Sonic Mighty Revo 16K MAX',
    'Sonic Mighty 8K',
    'Sonic Mini 8K S',
  ])
    assert.throws(() =>
      provisionPhrozenPrinter(scope, {
        ...local,
        expect: { ...local.expect, model: model as typeof MODEL },
      }),
    )
})

test('start is refused before the write even for a qualified pair', async (t) => {
  const { sim, binding, writes } = await printer(t)
  sim.addFile('part.ctb')
  sim.reset()
  let guarded = false
  await assert.rejects(
    attempt(router(QUALIFIED), binding, 'start_print', () => (guarded = true)),
    (error: unknown) =>
      refusal('unsupported-action')(error) &&
      (error as Error).message === 'resin-artifact-requires-library-version',
  )
  assert.equal(guarded, false)
  assert.deepEqual(writes(), [])
})

test('the direct driver refuses start before the write for a qualified pair', async (t) => {
  const { sim, binding, writes } = await printer(t)
  sim.addFile('part.ctb')
  sim.reset()
  const signal = new AbortController().signal
  const control = openFixedPhrozenControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal,
    phrozenQualifiedWrites: QUALIFIED,
  })
  t.after(() => control.close())
  await control.prepare()
  let guarded = false
  await assert.rejects(
    control.driver.execute!(
      'start_print',
      { file: 'part.ctb' },
      {
        binding,
        signal,
        beforeSend: () => (guarded = true),
      },
    ),
    (error: unknown) =>
      refusal('unsupported-action')(error) &&
      (error as Error).message === 'resin-artifact-requires-library-version',
  )
  assert.equal(guarded, false)
  assert.deepEqual(writes(), [])
})

test('upload eligibility enforces filename boundaries independently of the adapter', async (t) => {
  const { binding } = await printer(t)
  const target = { binding, qualifiedWrites: QUALIFIED }
  for (const name of ['a.ctb', 'A-_.PRZ', `${'a'.repeat(124)}.ctb`])
    assert.equal(supportsPhrozenUpload(target, name), true, name)
  for (const name of [
    '',
    '.ctb',
    '-a.ctb',
    'a b.ctb',
    'a/b.ctb',
    'a\\b.ctb',
    'a..b.ctb',
    'a.txt',
    'a.ctb\n',
    `${'a'.repeat(125)}.ctb`,
  ])
    assert.equal(supportsPhrozenUpload(target, name), false, name)
})

test('a denied write guard sends nothing', async (t) => {
  const { binding, writes } = await printer(t)
  await assert.rejects(
    attempt(router(QUALIFIED), binding, 'pause', () => false),
    refusal('state'),
  )
  assert.deepEqual(writes(), [])
})

test('an uncertain write is sent once and holds the next session', async (t) => {
  const { sim, binding, writes } = await printer(t)
  sim.misbehave(129, 'drop')
  const routes = router(QUALIFIED)
  await assert.rejects(
    attempt(routes, binding, 'pause', () => true),
    (error: unknown) =>
      !(error instanceof DriverRefusalError) &&
      /uncertain/.test((error as Error).message),
  )
  sim.misbehave(129, undefined)
  // The job is still printing: only the hold can refuse this one.
  await assert.rejects(
    attempt(routes, binding, 'pause', () => true),
    (error: unknown) =>
      error instanceof DriverRefusalError &&
      error.message.includes('uncertain-result-unacknowledged'),
  )
  assert.deepEqual(writes(), [129])
})
