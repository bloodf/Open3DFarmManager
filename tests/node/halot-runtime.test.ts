// HALOT in the Connector runtime: configuration, provisioning and writes behind
// the empty qualification list. Loopback simulator only: nothing here reaches a
// physical printer.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import {
  provisionHalotPrinter,
  readHalotPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedHalotControl } from '../../packages/connector/src/halot/control-driver.ts'
import { HALOT_MODEL_NAMES } from '../../packages/connector/src/halot/models.ts'
import {
  HALOT_QUALIFIED_WRITES,
  type HalotQualification,
} from '../../packages/connector/src/halot/qualification.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  HALOT_SIMULATOR_PASSWORD,
  startHalotSimulator,
} from '../../packages/sim-tools/src/halot-simulator.ts'

const MODEL = 'HALOT-MAGE PRO'
const OFFERED = ['pause', 'resume', 'cancel'] as const
const QUALIFIED: HalotQualification[] = OFFERED.map((operation) => ({
  operation,
  model: MODEL,
}))

async function printer(
  t: TestContext,
  options?: Parameters<typeof startHalotSimulator>[0],
) {
  const sim = await startHalotSimulator(options)
  t.after(sim.close)
  sim.beginPrint('part.cxdlpv4')
  const directory = await mkdtemp(join(tmpdir(), 'halot-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const origin = `ws://127.0.0.1:${sim.port}`
  const passwordFile = join(directory, 'halot.json')
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
    expect: { model: MODEL as typeof MODEL },
  }
  const binding = provisionHalotPrinter(scope, local)
  return { sim, directory, scope, local, binding }
}

const router = (qualified?: readonly HalotQualification[]) =>
  createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: () => true,
    ...(qualified ? { halotQualifiedWrites: qualified } : {}),
  })

async function attempt(
  binding: PrinterBinding,
  action: 'pause' | 'resume' | 'cancel' | 'start_print',
  beforeSend: () => boolean = () => true,
  qualified: readonly HalotQualification[] = QUALIFIED,
) {
  const routes = router(qualified)
  const signal = new AbortController().signal
  await routes.prepare({ binding, signal })
  try {
    return await routes.execute(
      action,
      action === 'start_print' ? { file: 'part.cxdlpv4' } : {},
      { binding, signal, beforeSend },
    )
  } finally {
    await routes.closeAttempt(binding)
  }
}

const refusal = (reason: DriverRefusalError['refusal']) => (error: unknown) =>
  error instanceof DriverRefusalError && error.refusal === reason

test('the shipped qualification list is empty: nothing is offered or sent', async (t) => {
  assert.deepEqual(HALOT_QUALIFIED_WRITES, [])
  const { sim, binding } = await printer(t)
  for (const qualified of [
    undefined,
    [{ operation: 'pause', model: 'HALOT-MAGE S' } as const],
  ]) {
    const routes = router(qualified)
    assert.deepEqual(routes.controls(binding), [])
    assert.deepEqual(await routes.detect(binding), [])
    assert.match(routes.startUnavailableMessage!(binding)!, /qualificados/)
  }
  for (const model of HALOT_MODEL_NAMES) {
    const signal = new AbortController().signal
    const control = openFixedHalotControl({
      binding: provisionHalotPrinter(
        {
          assignment_id: randomUUID(),
          farm_id: randomUUID(),
          agent_id: randomUUID(),
          printer_key: 'halot',
        },
        { ...readHalotPrinterBinding(binding)!, expect: { model } },
      ),
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal,
    })
    t.after(control.close)
    await control.prepare()
    for (const action of OFFERED)
      await assert.rejects(
        control.driver.execute!(
          action,
          {},
          {
            binding,
            signal,
            beforeSend: () => assert.fail('guard reached'),
          },
        ),
        refusal('unsupported-action'),
        `${model} ${action}`,
      )
    await control.close()
  }
  assert.deepEqual(sim.writes(), [])
})

test('only the qualified operations of the declared model are offered', async (t) => {
  const { binding } = await printer(t)
  assert.deepEqual(router(QUALIFIED).controls(binding), OFFERED)
  assert.deepEqual(
    router([{ operation: 'cancel', model: MODEL }]).controls(binding),
    ['cancel'],
  )
})

test('pause, resume and stop are sent once and confirmed by status', async (t) => {
  for (const pauseWord of ['PRINT_PAUSE', 'PRINT_STOP'] as const) {
    const { sim, binding } = await printer(t, { pauseWord })
    assert.deepEqual(await attempt(binding, 'pause'), { acknowledged: true })
    assert.equal(sim.machine.printStatus, pauseWord)
    assert.deepEqual(await attempt(binding, 'resume'), { acknowledged: true })
    assert.equal(sim.machine.printStatus, 'PRINT_PROCESSING')
    assert.deepEqual(await attempt(binding, 'cancel'), { acknowledged: true })
    assert.equal(sim.machine.printStatus, 'PRINT_END')
    assert.deepEqual(sim.writes(), ['PRINT_PAUSE', 'PRINT_PAUSE', 'PRINT_STOP'])
  }
})

test('the pause toggle is never sent from the wrong state', async (t) => {
  const { sim, binding } = await printer(t)
  // PRINT_PAUSE would resume a paused job and pause a running one.
  await assert.rejects(attempt(binding, 'resume'), refusal('state'))
  sim.machine.printStatus = 'PRINT_PAUSE'
  await assert.rejects(attempt(binding, 'pause'), refusal('state'))
  sim.idle()
  for (const action of OFFERED)
    await assert.rejects(attempt(binding, action), refusal('state'), action)
  assert.deepEqual(sim.writes(), [])
})

test('a job that changed since preparation is not touched', async (t) => {
  const { sim, binding } = await printer(t)
  const routes = router(QUALIFIED)
  const signal = new AbortController().signal
  await routes.prepare({ binding, signal })
  t.after(() => routes.closeAttempt(binding))
  sim.machine.filename = 'other.cxdlpv4'
  await assert.rejects(
    routes.execute('cancel', {}, { binding, signal, beforeSend: () => true }),
    refusal('state'),
  )
  assert.deepEqual(sim.writes(), [])
})

test('a denied write guard sends nothing', async (t) => {
  const { sim, binding } = await printer(t)
  await assert.rejects(attempt(binding, 'cancel', () => false))
  assert.deepEqual(sim.writes(), [])
})

test('an unapplied command stays uncertain and holds later writes', async (t) => {
  const { sim, binding } = await printer(t)
  sim.setFault('ignore')
  await assert.rejects(
    attempt(binding, 'pause'),
    (error: unknown) =>
      !(error instanceof DriverRefusalError) &&
      /uncertain/.test((error as Error).message),
  )
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
  // A second toggle could undo a late first one, even once the printer answers.
  sim.setFault()
  for (const action of OFFERED)
    await assert.rejects(attempt(binding, action), refusal('state'), action)
  assert.deepEqual(sim.writes(), ['PRINT_PAUSE'])
})

test('a write whose link drops before confirmation is held too', async (t) => {
  const { sim, binding } = await printer(t)
  await assert.rejects(
    attempt(binding, 'cancel', () => {
      queueMicrotask(() => sim.setFault('timeout'))
      return true
    }),
    (error: unknown) => !(error instanceof DriverRefusalError),
  )
  sim.setFault()
  await assert.rejects(attempt(binding, 'cancel'), refusal('state'))
  assert.deepEqual(sim.writes(), ['PRINT_STOP'])
})

test('upload and start are refused even with every operation qualified', async (t) => {
  const { sim, binding } = await printer(t)
  await assert.rejects(
    attempt(binding, 'start_print', () => assert.fail('guard reached')),
    DriverRefusalError,
  )
  assert.match(
    router(QUALIFIED).startUnavailableMessage!(binding)!,
    /não são suportados/,
  )
  assert.deepEqual(sim.writes(), [])
  assert.equal(sim.binaryFrames(), 0)
})

test('the runtime file reads a printer read-only until opted in and qualified', async (t) => {
  const { directory, scope, local } = await printer(t)
  const { publicKey } = generateKeyPairSync('ed25519')
  const path = join(directory, 'runtime.json')
  const assignment = { ...scope, backend: 'halot' }
  const credential = { agent_id: scope.agent_id, farm_id: scope.farm_id }
  const config = {
    version: 8,
    collection: {
      version: 8,
      printers: [],
      allowedOrigins: [local.origin],
      drivers: [local],
      limits: { requestTimeoutMs: 500 },
    },
    assignments: [assignment],
    telemetry: { endpoint: 'https://farm.example', audience: 'telemetry' },
  }
  const optIn = {
    ...config,
    pause: {
      version: 1,
      issuers: [
        {
          issuer: 'https://farm.example',
          kid: 'test',
          publicKeySpki: publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64url'),
        },
      ],
      control: { assignmentIds: [scope.assignment_id] },
      signalling: {
        origin: 'https://farm.example',
        endpoint: 'wss://farm.example/api/signalling/pause-connector',
        audience: 'pause',
        credentialAudience: 'credential',
      },
    },
  }
  async function read(
    value: unknown,
    qualified?: readonly HalotQualification[],
  ) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 })
    return readAgentRuntimeConfig(path, credential, {
      halotQualifiedWrites: qualified,
    })
  }
  const handle = async (
    value: unknown,
    qualified?: readonly HalotQualification[],
  ) => (await read(value, qualified)).bindingFor(scope.assignment_id)!

  // Read-only handles have no command mapping.
  assert.equal(readPrinterBinding(await handle(config)), null)
  assert.equal(readPrinterBinding(await handle(config, QUALIFIED)), null)
  assert.deepEqual(
    readHalotPrinterBinding(await handle(optIn, QUALIFIED))?.expect,
    { model: MODEL },
  )
  await assert.rejects(read(optIn), /Backend does not support pause control/)
  await assert.rejects(
    read({
      ...config,
      assignments: [{ ...assignment, backend: 'phrozen' }],
    }),
    /assignment mismatch/,
  )
  await assert.rejects(
    read({
      ...config,
      collection: { ...config.collection, allowedOrigins: ['ws://10.0.0.9:1'] },
    }),
    /allowlisted/,
  )
  await writeFile(local.passwordFile, '{}', { mode: 0o600 })
  await assert.rejects(read(config), /Invalid private HALOT password file/)
})
