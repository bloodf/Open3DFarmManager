// Loopback simulator only: nothing here reaches a physical printer. Outcomes
// are asserted from the state the simulator reports, never from the send.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import {
  provisionSdcpPrinter,
  readPrinterBinding,
  readSdcpPrinterBinding,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { withLibraryPrint } from '../../packages/connector/src/runtime/library-print-start.ts'
import { createSdcpCollection } from '../../packages/connector/src/runtime/sdcp-collection.ts'
import { buildSdcpCommand } from '../../packages/connector/src/sdcp/commands.ts'
import { openFixedSdcpControl } from '../../packages/connector/src/sdcp/control-driver.ts'
import { parseSdcpControlDiscovery } from '../../packages/connector/src/sdcp/identity.ts'
import { decodeSdcpStatus } from '../../packages/connector/src/sdcp/report.ts'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const MODELS = [
  { model: 'Saturn 4 Ultra', family: 'resin', file: 'part.ctb' },
  { model: 'Saturn 4 Ultra 16K', family: 'resin', file: 'part.goo' },
  { model: 'Mars 5 Ultra', family: 'resin', file: 'part.goo' },
  { model: 'Centauri Carbon', family: 'fdm', file: 'part.gcode' },
] as const
type Model = (typeof MODELS)[number]

// The Carbon's discovery names neither its address nor a protocol version.
const discoveryFor = (model: Model) => ({
  Id: 'fixture',
  Data: {
    Name: 'Test',
    MachineName: model.model as string,
    MainboardID: 'board01',
    FirmwareVersion: 'V1.0.0',
    ...(model.family === 'resin'
      ? { MainboardIP: '127.0.0.1', ProtocolVersion: 'V3.0.0' }
      : {}),
  } as Record<string, string>,
})

const ids = () => ({
  assignment_id: randomUUID(),
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  printer_key: 'elegoo',
})

async function printer(t: TestContext, model: Model, scope = ids()) {
  const sim = await startSdcpSimulator(discoveryFor(model))
  t.after(sim.close)
  const machine = sim.simulate({ family: model.family })
  machine.files.set(model.file, Buffer.from('synthetic'))
  const binding = provisionSdcpPrinter(scope, {
    printerKey: scope.printer_key,
    host: '127.0.0.1',
    mainboardId: 'board01',
    model: model.model,
    discoveryPort: sim.discoveryPort,
    websocketPort: sim.websocketPort,
    uploadPort: sim.websocketPort,
  })
  return { sim, machine, binding }
}

const commands = (requests: unknown[]) =>
  requests
    .map((request) => (request as any).Data)
    .filter((data) => data.Cmd !== 0)

function router(observe: (observation: ControlObservation) => void) {
  return createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: (_binding, observation) => {
      if (observation) observe(observation)
      return true
    },
  })
}

/** One attempt, as the dispatcher runs it: prepare, execute once, confirm. */
async function attempt(
  binding: PrinterBinding,
  action: ExtendedControlAction,
  args: Record<string, unknown> = {},
) {
  const seen: ControlObservation[] = []
  const routes = router((observation) => seen.push(observation))
  const signal = new AbortController().signal
  try {
    await routes.prepare({ binding, signal })
    let after = {
      connectionGeneration: 0,
      sequence: 0,
      sentMono: 0,
    }
    const request = {
      binding,
      signal,
      beforeSend() {
        const last = seen.at(-1)!
        after = {
          connectionGeneration: last.connectionGeneration,
          sequence: last.sequence,
          sentMono: performance.now(),
        }
        return true
      },
    }
    await routes.execute(action, args, request)
    const confirmed = await routes.waitForPaused({
      binding,
      signal,
      action: action as 'pause',
      args,
      after,
    })
    await assert.rejects(routes.execute(action, args, request))
    return confirmed
  } finally {
    await routes.closeAttempt(binding)
  }
}

for (const model of MODELS) {
  test(`${model.model} applies start, pause, resume and cancel and reports each state`, async (t) => {
    const { sim, machine, binding } = await printer(t, model)
    assert.deepEqual(await router(() => {}).detect(binding), [
      'pause',
      'resume',
      'cancel',
      'start_print',
    ])
    const started = await attempt(binding, 'start_print', { file: model.file })
    assert.equal(started?.printState, 'printing')
    assert.equal(started?.effect?.kind, 'file')
    assert.equal((started?.effect as { filename: string }).filename, model.file)
    assert.equal(machine.phase, 'printing')

    assert.equal((await attempt(binding, 'pause'))?.printState, 'paused')
    assert.equal(machine.phase, 'paused')
    assert.equal((await attempt(binding, 'resume'))?.printState, 'printing')
    assert.equal(machine.phase, 'printing')
    assert.equal((await attempt(binding, 'cancel'))?.printState, 'cancelled')
    assert.equal(machine.phase, 'stopped')

    // Exactly one frame per attempt, in the documented shape.
    const sent = commands(sim.requests)
    assert.deepEqual(
      sent.map((data) => data.Cmd),
      [128, 129, 131, 130],
    )
    assert.deepEqual(
      sent[0].Data,
      model.family === 'resin'
        ? { Filename: model.file, StartLayer: 0 }
        : {
            Filename: model.file,
            StartLayer: 0,
            Calibration_switch: 1,
            PrintPlatformType: 0,
            Tlp_Switch: 0,
            slot_map: [],
          },
    )
    assert.equal(sent[0].From, model.family === 'resin' ? 0 : 1)
    assert.equal(sent[0].MainboardID, 'board01')
  })
}

async function openDriver(binding: PrinterBinding, timeoutMs = 300) {
  const seen: ControlObservation[] = []
  const driver = openFixedSdcpControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: (observation) => observation && seen.push(observation),
    signal: new AbortController().signal,
    timeoutMs,
    pollMs: 20,
  })
  await driver.prepare()
  let guards = 0
  return {
    driver,
    seen,
    guards: () => guards,
    run: (action: ExtendedControlAction, args: Record<string, unknown> = {}) =>
      driver.driver.execute!(action, args, {
        binding,
        signal: new AbortController().signal,
        beforeSend: () => {
          guards++
          return true
        },
      }),
  }
}

test('a library start is not advertised for SDCP', async (t) => {
  const { binding } = await printer(t, MODELS[3])
  const wrapped = withLibraryPrint(
    router(() => {}),
    {
      starter: {
        start: () => Promise.reject(new Error('unreachable')),
      },
      targetFor: () => ({ backend: 'sdcp', binding }),
    },
  )
  assert.deepEqual(wrapped.controls!(binding), [
    'pause',
    'resume',
    'cancel',
    'start_print',
  ])
})

test('an acknowledgement without a state change never confirms', async (t) => {
  const { machine, binding, sim } = await printer(t, MODELS[0])
  machine.phase = 'printing'
  machine.fault = { ignore: true }
  const control = await openDriver(binding)
  t.after(() => control.driver.close())
  await assert.rejects(control.run('pause'), {
    code: 'SDCP_CONTROL_TIMEOUT',
  })
  assert.equal(control.seen.at(-1)?.printState, 'printing')
  assert.equal(commands(sim.requests).length, 1, 'no retry')
})

test('a refused acknowledgement fails the attempt without a retry', async (t) => {
  const { machine, binding, sim } = await printer(t, MODELS[1])
  machine.fault = { ack: 1 }
  const control = await openDriver(binding)
  t.after(() => control.driver.close())
  await assert.rejects(
    control.run('start_print', { file: 'part.goo' }),
    /Ack 1/,
  )
  assert.equal(control.seen.at(-1)?.printState, 'idle')
  await assert.rejects(control.run('start_print', { file: 'part.goo' }))
  assert.equal(commands(sim.requests).length, 1)
})

test('a missing file is refused by the printer and nothing starts', async (t) => {
  const { machine, binding } = await printer(t, MODELS[3])
  const control = await openDriver(binding)
  t.after(() => control.driver.close())
  await assert.rejects(
    control.run('start_print', { file: 'absent.gcode' }),
    /Ack 2/,
  )
  assert.equal(machine.phase, 'idle')
})

test('a start waits while the printer reports a file transfer', async (t) => {
  const { sim, machine, binding } = await printer(t, MODELS[0])
  machine.transferring = true
  const control = await openDriver(binding)
  t.after(() => control.driver.close())
  await assert.rejects(control.run('start_print', { file: 'part.ctb' }), {
    code: 'SDCP_CONTROL_TIMEOUT',
  })
  assert.equal(control.guards(), 0)
  assert.equal(commands(sim.requests).length, 0)
})

test('invalid arguments, unlisted actions and a denied guard send nothing', async (t) => {
  const { sim, binding } = await printer(t, MODELS[3])
  for (const [action, args] of [
    ['emergency_stop', {}],
    ['set_temperature', { heater: 'bed', target_c: 60 }],
    ['set_light', { on: true }],
    ['start_print', { file: '../part.gcode' }],
    ['start_print', { file: 'part.ctb' }],
    ['start_print', { file: 'part.gcode', plate: 1 }],
    ['pause', { extra: true }],
  ] as const) {
    const control = await openDriver(binding)
    await assert.rejects(control.run(action, args), `${action}`)
    assert.equal(control.guards(), 0)
    await control.driver.close()
  }
  const control = await openDriver(binding)
  t.after(() => control.driver.close())
  await assert.rejects(
    control.driver.driver.execute!(
      'pause',
      {},
      {
        binding,
        signal: new AbortController().signal,
        beforeSend: () => false,
      },
    ),
  )
  assert.equal(commands(sim.requests).length, 0)
})

test('a changed identity behind the address receives no command', async (t) => {
  const sim = await startSdcpSimulator(discoveryFor(MODELS[0]))
  t.after(sim.close)
  sim.simulate({ family: 'resin', phase: 'printing' })
  const scope = ids()
  const binding = provisionSdcpPrinter(scope, {
    printerKey: scope.printer_key,
    host: '127.0.0.1',
    mainboardId: 'another-board',
    model: 'Saturn 4 Ultra',
    discoveryPort: sim.discoveryPort,
    websocketPort: sim.websocketPort,
  })
  await assert.rejects(openDriver(binding))
  assert.equal(sim.connected(), 0)
  assert.equal(sim.requests.length, 0)
})

test('models without documented SDCP control cannot be provisioned', () => {
  const scope = ids()
  for (const model of [
    'Centauri Carbon 2',
    'Saturn 3 Ultra',
    'Mars 4 Ultra',
    'Jupiter 2',
    'Saturn 2',
    'Mars 3 Pro',
  ]) {
    assert.throws(() =>
      provisionSdcpPrinter(scope, {
        printerKey: scope.printer_key,
        host: '127.0.0.1',
        mainboardId: 'board01',
        model,
      }),
    )
    assert.throws(() => buildSdcpCommand(model, 'pause'))
    assert.equal(
      parseSdcpControlDiscovery(
        Buffer.from(
          JSON.stringify(discoveryFor({ ...MODELS[0], model } as never)),
        ),
        '127.0.0.1',
      ),
      undefined,
    )
  }
})

test('resin discovery still requires its address and protocol version', () => {
  const parse = (data: Record<string, string>) =>
    parseSdcpControlDiscovery(
      Buffer.from(JSON.stringify({ Id: 'fixture', Data: data })),
      '127.0.0.1',
    )
  const { Data } = discoveryFor(MODELS[0])
  assert.ok(parse(Data))
  const { ProtocolVersion: _version, ...unversioned } = Data
  assert.equal(parse(unversioned), undefined)
  assert.equal(parse({ ...Data, MainboardIP: '192.0.2.1' }), undefined)
  const carbon = discoveryFor(MODELS[3]).Data
  assert.ok(parse(carbon))
  assert.equal(parse({ ...carbon, ProtocolVersion: 'V1.0.0' }), undefined)
  assert.equal(parse({ ...carbon, MainboardIP: '192.0.2.1' }), undefined)
})

test('transitional and unrecognised sub-states permit and confirm nothing', () => {
  const state = (current: number[], phase: number, family = 'resin') =>
    decodeSdcpStatus(
      JSON.stringify({
        MainboardID: 'board01',
        Topic: 'sdcp/status/board01',
        Status: {
          CurrentStatus: current,
          PrintInfo: { Status: phase, ErrorNumber: 0 },
        },
      }),
      'board01',
      family as 'resin',
    )?.state
  assert.equal(state([1], 5), 'unknown')
  assert.equal(state([1], 7), 'unknown')
  assert.equal(state([1], 13), 'unknown')
  assert.equal(state([1], 13, 'fdm'), 'printing')
  assert.equal(state([1], 14, 'fdm'), 'error')
  assert.equal(state([2], 0), 'unknown')
  assert.equal(state([0], 6), 'unknown')
  assert.equal(state([0], 8), 'cancelled')
  assert.equal(state([0], 9), 'idle')
})

test('only a signed command in scope reaches the printer, confirmed by its report', async (t) => {
  const authority = await createV2Authority(await nodeSigner())
  const { sim, machine, binding } = await printer(t, MODELS[1], {
    assignment_id: authority.ids.assignment_id,
    farm_id: authority.ids.farm_id,
    agent_id: authority.ids.agent_id,
    printer_key: authority.printerKey,
  })
  machine.phase = 'printing'
  let outer: PrinterBinding
  const world = await openV2Dispatch(authority, {
    capability: { actions: ['pause'] },
    loopback: {
      origin: 'http://127.0.0.1:7125',
      driver({ clock, observe }) {
        const routes = createPauseDriverRouter({
          allowedOrigins: [],
          limits: {} as never,
          clock,
          observe: (_inner, observation) => observe(outer, observation),
        })
        // The shared helper owns its binding; route its calls to the SDCP one.
        return {
          detect: async () => {},
          controls: () => routes.controls(binding),
          prepare(input) {
            outer = input.binding
            return routes.prepare({ binding, signal: input.signal })
          },
          execute: (action, args, input) =>
            routes.execute(action, args, { ...input, binding }),
          pauseOnce: (input) => routes.pauseOnce({ ...input, binding }),
          waitForPaused: (input) => routes.waitForPaused({ ...input, binding }),
          closeAttempt: () => routes.closeAttempt(binding),
        }
      },
    },
  })
  t.after(world.close)
  const wire = await authority.sign({}, world.now())
  const tampered = JSON.parse(wire)
  tampered.nonce = Buffer.alloc(16, 1).toString('base64url')
  assert.deepEqual(await world.dispatch(JSON.stringify(tampered)), {
    kind: 'rejected',
    reason: 'signature',
  })
  assert.deepEqual(
    await world.dispatch(
      await authority.sign(
        { purpose: 'printer-control', action: 'cancel' },
        world.now(),
      ),
    ),
    { kind: 'rejected', reason: 'scope' },
  )
  assert.equal(sim.requests.length, 0)
  const result = await world.dispatch(wire)
  assert.equal(result.kind, 'applied', JSON.stringify(result))
  assert.equal(machine.phase, 'paused')
  assert.deepEqual(
    commands(sim.requests).map((data) => data.Cmd),
    [129],
  )
})

function runtimeConfig(t: TestContext, model: string, control: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'sdcp-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const scope = ids()
  const path = join(directory, 'runtime.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 6,
      collection: {
        version: 6,
        allowedOrigins: [],
        printers: [],
        sdcp: {
          printers: [
            {
              printerKey: scope.printer_key,
              host: '192.0.2.10',
              mainboardId: 'board01',
              model,
            },
          ],
        },
      },
      assignments: [{ ...scope, backend: 'sdcp' }],
      telemetry: {
        endpoint: 'https://farm.example/api/connector/telemetry',
        audience: 'open3dfarmmanager:telemetry',
      },
      ...(control
        ? {
            pause: {
              version: 1,
              control: { assignmentIds: [scope.assignment_id] },
              issuers: [
                {
                  issuer: 'farm:issuer',
                  kid: 'issuer-1',
                  publicKeySpki: generateKeyPairSync('ed25519')
                    .publicKey.export({ format: 'der', type: 'spki' })
                    .toString('base64url'),
                },
              ],
              signalling: {
                origin: 'https://farm.example',
                endpoint: 'wss://farm.example/api/signalling/pause-connector',
                audience: 'open3dfarmmanager:signalling',
                credentialAudience: 'open3dfarmmanager:credential',
              },
            },
          }
        : {}),
    }),
    { mode: 0o600 },
  )
  return { path, scope }
}

test('runtime provisions control only for an explicit assignment opt-in', (t) => {
  for (const control of [false, true]) {
    const { path, scope } = runtimeConfig(t, 'Centauri Carbon', control)
    const config = readAgentRuntimeConfig(path, scope)
    const binding = config.bindingFor(scope.assignment_id)!
    assert.equal(!!readPrinterBinding(binding), control)
    assert.equal(!!readSdcpPrinterBinding(binding), control)
    assert.deepEqual(
      router(() => {}).controls(binding),
      control ? ['pause', 'resume', 'cancel', 'start_print'] : [],
    )
  }
})

test('the Centauri Carbon collects status through its own shapes', async (t) => {
  const sim = await startSdcpSimulator(discoveryFor(MODELS[3]))
  t.after(sim.close)
  sim.simulate({
    family: 'fdm',
    phase: 'printing',
    currentLayer: 25,
    totalLayer: 100,
  })
  const abort = new AbortController()
  const observations: any[] = []
  const collection = createSdcpCollection({
    binding: {
      printerKey: 'elegoo',
      host: '127.0.0.1',
      mainboardId: 'board01',
      model: 'Centauri Carbon',
    },
    signal: abort.signal,
    endpoints: {
      discoveryPort: sim.discoveryPort,
      websocketPort: sim.websocketPort,
      pollMs: 5,
      retryMs: 500,
    },
    onObservation: (value) => observations.push(value),
    onUnavailable: () => {},
  })
  for (let i = 0; i < 300 && !observations.length; i++) await sleep(10)
  abort.abort()
  await collection.done
  assert.equal(observations[0]?.printer.state, 'printing')
  assert.equal(observations[0]?.printer.progress, 0.25)
  assert.equal(commands(sim.requests).length, 0)
})
