// Signed Flashforge control against the original synthetic simulator. Wire
// formats: Parallel-7/flashforge-api-docs wiki @ 885702f. No real printer.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import {
  buildFilamentSlotArgs,
  unsupportedExtended,
  writeDialogDescription,
} from '../../apps/farm/app/utils/farm-control-extended.ts'
import { filamentTrays } from '../../apps/farm/app/utils/farm-macros.ts'
import { farmSlotLabel } from '../../apps/farm/app/utils/slot-spools.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createFlashforgeCollection,
  type FlashforgeObservation,
} from '../../packages/connector/src/flashforge/collection.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { loadMigrationCatalog } from '../../scripts/db/migrations.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { parseCameraRuntimeConfig } from '../../packages/connector/src/config/camera.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import type {
  ControlObservation,
  PreparedPauseDriver,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  provisionFlashforgePrinter,
  readFlashforgePrinterBinding,
  readPrinterBinding,
  readRuntimePrinterBinding,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedFlashforgeControl } from '../../packages/connector/src/flashforge/control-driver.ts'
import { createFlashforgeAdapter } from '../../packages/connector/src/flashforge/index.ts'
import {
  FLASHFORGE_CONTROLS,
  FLASHFORGE_QUALIFIED_WRITES,
  type FlashforgeModel,
  type FlashforgeQualification,
} from '../../packages/connector/src/flashforge/qualification.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { startStatefulFlashforgeSimulator } from '../../packages/sim-tools/src/flashforge-simulator.ts'
import { flashforgeModels } from '../fixtures/flashforge/models.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const MODELS = flashforgeModels.map((model) => ({
  ...model,
  name: model.name as FlashforgeModel,
  version: model.firmware[0]!,
}))
const QUALIFIED: FlashforgeQualification[] = MODELS.map((model) => ({
  model: model.name,
  firmware: model.version,
}))
const AD5X = MODELS[2]!

/** Four loaded or empty slots with the station reference's 1-4 numbering. */
const station = () => ({
  slotCnt: 4,
  currentSlot: 1,
  currentLoadSlot: 0,
  stateAction: 0,
  stateStep: 0,
  slotInfos: [1, 2, 3, 4].map((slotId) => ({
    slotId,
    hasFilament: slotId !== 3,
    materialName: 'PLA',
    materialColor: '#FFFFFF',
  })),
})

type Scope = {
  assignment_id: string
  farm_id: string
  agent_id: string
  printer_key: string
}
const newScope = (): Scope => ({
  assignment_id: randomUUID(),
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  printer_key: 'flashforge-1',
})

async function printer(
  t: TestContext,
  model: (typeof MODELS)[number],
  scope = newScope(),
) {
  const sim = await startStatefulFlashforgeSimulator({
    ...model,
    detail: {
      ...model.detail,
      firmwareVersion: `v${model.version}`,
      ...(model.pid === 38 ? { matlStationInfo: station() } : {}),
    },
  })
  const directory = mkdtempSync(join(tmpdir(), 'flashforge-control-'))
  t.after(async () => {
    await sim.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const origin = `http://${sim.host}:${sim.port}`
  const credentialFile = join(directory, 'credential.json')
  writeFileSync(
    credentialFile,
    JSON.stringify({
      origin,
      serialNumber: 'FIXTURE-SERIAL',
      checkCode: 'fixture01',
    }),
    { mode: 0o600 },
  )
  const local = {
    family: 'flashforge' as const,
    printerKey: scope.printer_key,
    origin,
    credentialFile,
    expect: { serialNumber: 'FIXTURE-SERIAL', model: model.name },
    simulated: true,
    control: true as const,
  }
  return {
    sim,
    local,
    directory,
    binding: provisionFlashforgePrinter(scope, local),
  }
}

const router = (
  qualified: FlashforgeQualification[] | undefined,
  observe: (
    binding: PrinterBinding,
    observation: ControlObservation | null,
  ) => boolean = () => true,
  clock = { monotonicNow: () => performance.now() },
) =>
  createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock,
    observe,
    ...(qualified ? { flashforgeQualifiedWrites: qualified } : {}),
  })

/** The shipped dispatcher and journal over the real router, signed commands. */
async function signed(
  t: TestContext,
  model: (typeof MODELS)[number],
  qualified: FlashforgeQualification[] | undefined,
) {
  const authority = await createV2Authority(await nodeSigner())
  const target = await printer(t, model, {
    assignment_id: authority.ids.assignment_id,
    farm_id: authority.ids.farm_id,
    agent_id: authority.ids.agent_id,
    printer_key: authority.printerKey,
  })
  let outer: PrinterBinding
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: {
      role: 'owner',
      actions: [
        ...FLASHFORGE_CONTROLS.AD5X,
        'set_camera_stream',
        'unload_filament',
        'start_print',
      ],
    },
    loopback: {
      origin: 'http://127.0.0.1:7125',
      driver({ clock, observe }) {
        const routes = router(
          qualified,
          (_inner, observation) => observe(outer, observation),
          clock,
        )
        const inner = target.binding
        const driver: PreparedPauseDriver & {
          detect(binding: PrinterBinding): Promise<unknown>
        } = {
          detect: () => routes.detect(inner),
          controls: () => routes.controls(inner),
          resultWindowMs: (_binding, action) =>
            routes.resultWindowMs?.(inner, action),
          prepare(input) {
            outer = input.binding
            retired = undefined
            return routes.prepare({ binding: inner, signal: input.signal })
          },
          execute: (action, args, input) =>
            routes.execute(action, args, { ...input, binding: inner }),
          pauseOnce: (input) => routes.pauseOnce({ ...input, binding: inner }),
          waitForPaused: (input) =>
            routes.waitForPaused({ ...input, binding: inner }),
          closeAttempt() {
            retired = routes.closeAttempt(inner)
            return retired
          },
        }
        return driver
      },
    },
  })
  t.after(() => session.close())
  return {
    ...target,
    async run(
      action: ExtendedControlAction,
      args: Record<string, unknown> = {},
    ) {
      const result = await session.dispatch(
        await authority.sign(
          {
            action,
            args,
            purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
          },
          session.now(),
        ),
      )
      await retired
      return result
    },
  }
}

test('the shipped Flashforge write qualification list is empty', () => {
  assert.deepEqual(FLASHFORGE_QUALIFIED_WRITES, [])
})

for (const model of MODELS) {
  test(`${model.name}: unqualified writes are neither offered nor sent`, async (t) => {
    const target = await signed(t, model, undefined)
    for (const [action, args] of [
      ['pause', {}],
      ['set_temperature', { heater: 'bed', target_c: 40 }],
      ['load_filament', { tray: 1 }],
      ['set_camera_stream', { on: false }],
      ['set_filament_slot', { tray: 1, material: 'PETG', color: '#112233' }],
    ] as const) {
      const result = await target.run(action, args)
      assert.equal(result.kind, 'rejected', JSON.stringify(result))
      assert.equal('reason' in result && result.reason, 'unsupported-action')
    }
    // An empty list needs no firmware read: nothing reached the printer.
    assert.deepEqual(target.sim.requests, [])

    // The driver refuses on its own too, before any write.
    target.sim.detail.status = 'printing'
    const driver = openFixedFlashforgeControl({
      binding: target.binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: new AbortController().signal,
      pollMs: 20,
    })
    t.after(() => driver.close())
    await driver.prepare()
    await assert.rejects(
      driver.driver.execute!('pause', {}, request(target.binding)),
      (error: unknown) =>
        error instanceof DriverRefusalError &&
        error.refusal === 'unsupported-action' &&
        /ainda não foram qualificados/.test(error.userMessage ?? ''),
    )
    assert.deepEqual(target.sim.writes, [])
  })

  test(`${model.name}: a test-only qualification applies signed writes once each`, async (t) => {
    const target = await signed(t, model, QUALIFIED)
    const { sim } = target
    sim.detail.status = 'printing'
    sim.detail.printFileName = 'fixture.gcode'
    const steps: [ExtendedControlAction, Record<string, unknown>, unknown][] = [
      [
        'set_temperature',
        { heater: 'extruder', target_c: 195 },
        { cmd: 'temperatureCtl_cmd', args: { rightNozzle: 195 } },
      ],
      [
        'set_temperature',
        { heater: 'bed', target_c: 0 },
        { cmd: 'temperatureCtl_cmd', args: { platform: -100 } },
      ],
      [
        'set_fan',
        { fan: 'part', percent: 40 },
        { cmd: 'printerCtl_cmd', args: { coolingFan: 40 } },
      ],
      [
        'pause',
        {},
        { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'pause' } },
      ],
      [
        'resume',
        {},
        { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'continue' } },
      ],
      [
        'cancel',
        {},
        { cmd: 'jobCtl_cmd', args: { jobID: '', action: 'cancel' } },
      ],
    ]
    for (const [action, args] of steps) {
      const result = await target.run(action, args)
      assert.equal(
        result.kind,
        'applied',
        `${action} ${JSON.stringify(result)}`,
      )
    }
    assert.deepEqual(
      sim.writes,
      steps.map(([, , payload]) => ({ path: '/control', payload })),
    )
    // Start has no signed binding for any model.
    const start = await target.run('start_print', { file: 'fixture.gcode' })
    assert.equal(start.kind, 'rejected')
    assert.equal(sim.writes.length, steps.length)
  })
}

test('AD5X: a signed slot load is confirmed by the station readback', async (t) => {
  const target = await signed(t, AD5X, QUALIFIED)
  const result = await target.run('load_filament', { tray: 1 })
  assert.equal(result.kind, 'applied', JSON.stringify(result))
  assert.deepEqual(target.sim.writes, [
    {
      path: '/control',
      payload: { cmd: 'ms_cmd', args: { slot: 2, action: 0 } },
    },
  ])
  const unload = await target.run('unload_filament')
  assert.equal(unload.kind, 'rejected')
  assert.equal('reason' in unload && unload.reason, 'unsupported-action')
  assert.equal(target.sim.writes.length, 1)
})

test('an acknowledgement without a readback is uncertain and not retried', async (t) => {
  const target = await signed(t, MODELS[1]!, QUALIFIED)
  target.sim.detail.status = 'printing'
  target.sim.detail.printFileName = 'fixture.gcode'
  target.sim.faults.ignoreControl = true
  const result = await target.run('pause')
  assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
  assert.equal(target.sim.writes.length, 1)
})

function request(binding: PrinterBinding, sent = { count: 0 }) {
  return {
    binding,
    signal: new AbortController().signal,
    beforeSend() {
      sent.count++
      return true
    },
  }
}

async function open(t: TestContext, binding: PrinterBinding) {
  const driver = openFixedFlashforgeControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal: new AbortController().signal,
    pollMs: 20,
    timeoutMs: 1000,
    qualifiedWrites: QUALIFIED,
  })
  t.after(() => driver.close())
  await driver.prepare()
  return driver
}

test('pre-write refusals are typed and send nothing', async (t) => {
  const cases: [
    number,
    ExtendedControlAction,
    Record<string, unknown>,
    string,
    ((detail: Record<string, unknown>) => void)?,
  ][] = [
    [
      0,
      'set_temperature',
      { heater: 'chamber', target_c: 40 },
      'invalid-command',
    ],
    [
      0,
      'set_temperature',
      { heater: 'extruder', target_c: 266 },
      'invalid-command',
    ],
    [2, 'set_temperature', { heater: 'bed', target_c: 101 }, 'invalid-command'],
    [1, 'set_fan', { fan: 'aux', percent: 10 }, 'invalid-command'],
    [2, 'load_filament', {}, 'invalid-command'],
    [2, 'load_filament', { tray: 4 }, 'invalid-command'],
    // Empty slot, slot already active, busy station, ambiguous numbering.
    [2, 'load_filament', { tray: 2 }, 'state'],
    [2, 'load_filament', { tray: 0 }, 'state'],
    [
      2,
      'load_filament',
      { tray: 1 },
      'state',
      (detail) => {
        detail.matlStationInfo = { ...station(), stateAction: 1 }
      },
    ],
    [
      2,
      'load_filament',
      { tray: 1 },
      'state',
      (detail) => {
        const value = station()
        value.slotInfos[0]!.slotId = 0
        detail.matlStationInfo = value
      },
    ],
    [0, 'load_filament', { tray: 1 }, 'unsupported-action'],
    [2, 'unload_filament', {}, 'unsupported-action'],
    [2, 'start_print', { file: 'fixture.gcode' }, 'unsupported-action'],
    // Nothing is printing, so there is no job to resume.
    [1, 'resume', {}, 'state'],
  ]
  for (const [index, action, args, refusal, arrange] of cases) {
    const target = await printer(t, MODELS[index]!)
    arrange?.(target.sim.detail)
    const driver = await open(t, target.binding)
    const sent = { count: 0 }
    await assert.rejects(
      driver.driver.execute!(action, args, request(target.binding, sent)),
      (error: unknown) =>
        error instanceof DriverRefusalError && error.refusal === refusal,
      `${action} ${JSON.stringify(args)}`,
    )
    assert.equal(sent.count, 0, action)
    assert.deepEqual(target.sim.writes, [], action)
    await driver.close()
  }
})

test('firmware that leaves the qualified pair is refused before the write', async (t) => {
  const target = await printer(t, MODELS[0]!)
  target.sim.detail.status = 'printing'
  target.sim.detail.printFileName = 'fixture.gcode'
  const routes = router([QUALIFIED[0]!])
  assert.deepEqual(routes.controls(target.binding), [])
  assert.match(
    routes.startUnavailableMessage?.(target.binding) ?? '',
    /qualificados/,
  )
  await routes.detect(target.binding)
  assert.deepEqual(
    routes.controls(target.binding),
    FLASHFORGE_CONTROLS['Adventurer 5M'],
  )
  const driver = await open(t, target.binding)
  // Allowlisted by the adapter, absent from the qualification list.
  target.sim.detail.firmwareVersion = 'v5.1.8'
  await assert.rejects(
    driver.driver.execute!('pause', {}, request(target.binding)),
    (error: unknown) =>
      error instanceof DriverRefusalError &&
      error.refusal === 'unsupported-action',
  )
  assert.deepEqual(target.sim.writes, [])
})

test('command binding needs the binding flag and the pause entry', async (t) => {
  const credential = {
    agent_id: randomUUID(),
    farm_id: randomUUID(),
  }
  const assignment = {
    ...credential,
    assignment_id: randomUUID(),
    printer_key: 'flashforge-1',
    backend: 'flashforge',
  }
  const target = await printer(t, MODELS[1]!)
  const { publicKey } = generateKeyPairSync('ed25519')
  const pause = {
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
    control: { assignmentIds: [assignment.assignment_id] },
    signalling: {
      origin: 'https://farm.example',
      endpoint: 'wss://farm.example/api/signalling/pause-connector',
      audience: 'pause',
      credentialAudience: 'credential',
    },
  }
  function read(control: boolean, withPause: boolean) {
    const { control: _flag, ...driver } = target.local
    const path = join(target.directory, 'runtime.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: 8,
        collection: {
          version: 8,
          printers: [],
          allowedOrigins: [driver.origin],
          drivers: [control ? { ...driver, control: true } : driver],
          limits: { requestTimeoutMs: 500 },
        },
        assignments: [assignment],
        telemetry: {
          endpoint: 'https://farm.example',
          audience: 'telemetry',
        },
        ...(withPause ? { pause } : {}),
      }),
      { mode: 0o600 },
    )
    return readAgentRuntimeConfig(path, credential as never)
  }
  const bound = read(true, true).bindingFor(assignment.assignment_id)!
  assert.ok(readFlashforgePrinterBinding(bound))
  assert.equal(readRuntimePrinterBinding(bound)?.printer_key, 'flashforge-1')
  for (const control of [true, false]) {
    const handle = read(control, false).bindingFor(assignment.assignment_id)!
    assert.equal(readFlashforgePrinterBinding(handle), null)
    assert.equal(readPrinterBinding(handle), null)
  }
  assert.throws(() => read(false, true), /does not support pause control/)
})

test('history is refused, and slot 4 reads without error', async (t) => {
  const target = await printer(t, AD5X)
  const adapter = createFlashforgeAdapter({
    ...target.sim,
    serialNumber: 'FIXTURE-SERIAL',
    checkCode: 'fixture01',
  })
  await assert.rejects(adapter.readHistory(), /no documented LAN history/)
  assert.deepEqual(
    (await adapter.readStatus()).slots?.map((slot) => slot.id),
    [1, 2, 3, 4],
  )
  // Without the driver's opt-in the adapter keeps the AD5X read-only.
  await assert.rejects(
    adapter.execute({ kind: 'slot-load', slot: 2 }, () => true),
    /unavailable on AD5X/,
  )
  assert.deepEqual(target.sim.writes, [])
})

test('an unqualified adapter cannot activate the 5M Pro camera', async (t) => {
  const target = await printer(t, MODELS[1]!)
  target.sim.detail.cameraStreamUrl = ''
  const adapter = createFlashforgeAdapter({
    ...target.sim,
    serialNumber: 'FIXTURE-SERIAL',
    checkCode: 'fixture01',
  })
  await assert.rejects(
    adapter.execute({ kind: 'camera', on: true }, () => true),
    (error: unknown) =>
      error instanceof DriverRefusalError &&
      error.refusal === 'unsupported-action',
  )
  assert.deepEqual(target.sim.writes, [])
})

test('the Flashforge camera source fixes the documented MJPEG path', () => {
  const assignmentId = randomUUID()
  const config = (source: object) =>
    parseCameraRuntimeConfig(
      {
        helper: { path: '/usr/bin/ffmpeg', sha256: '0'.repeat(64) },
        cameras: [{ cameraId: 'camera', assignmentId, source }],
      },
      [assignmentId],
    )
  const source = {
    kind: 'flashforge-mjpeg',
    address: '192.168.1.20',
    port: 8080,
  }
  assert.deepEqual(config(source).cameras[0]!.source, {
    ...source,
    path: '/?action=stream',
  })
  assert.throws(() => config({ ...source, path: '/other' }))
  assert.throws(() => config({ ...source, address: '8.8.8.8' }))
})

for (const model of [MODELS[0]!, MODELS[1]!]) {
  test(`${model.name}: signed camera activation is confirmed by cameraStreamUrl`, async (t) => {
    const target = await signed(t, model, QUALIFIED)
    const { sim } = target
    // `cameraStreamUrl` is empty while the camera is off.
    sim.detail.cameraStreamUrl = ''
    for (const on of [true, false]) {
      const result = await target.run('set_camera_stream', { on })
      assert.equal(result.kind, 'applied', JSON.stringify(result))
    }
    assert.equal(sim.detail.cameraStreamUrl, '')
    assert.deepEqual(
      sim.writes,
      ['open', 'close'].map((action) => ({
        path: '/control',
        payload: { cmd: 'streamCtrl_cmd', args: { action } },
      })),
    )
  })
}

test('AD5X: a signed slot record is confirmed by the station report', async (t) => {
  const target = await signed(t, AD5X, QUALIFIED)
  const args = { tray: 1, material: 'PETG', color: '#11AA33' }
  const result = await target.run('set_filament_slot', args)
  assert.equal(result.kind, 'applied', JSON.stringify(result))
  // The station page gives `rgb` without the `#` prefix.
  assert.deepEqual(target.sim.writes, [
    {
      path: '/control',
      payload: {
        cmd: 'msConfig_cmd',
        args: { slot: 2, mt: 'PETG', rgb: '11AA33' },
      },
    },
  ])
  const camera = await target.run('set_camera_stream', { on: true })
  assert.equal(camera.kind, 'rejected')
  assert.equal('reason' in camera && camera.reason, 'unsupported-action')
  assert.equal(target.sim.writes.length, 1)
})

test('ignored camera and slot writes stay uncertain and are not resent', async (t) => {
  for (const [model, action, args] of [
    [MODELS[1]!, 'set_camera_stream', { on: false }],
    [AD5X, 'set_filament_slot', { tray: 0, material: 'ABS', color: '#000000' }],
  ] as const) {
    const target = await signed(t, model, QUALIFIED)
    target.sim.faults.ignoreControl = true
    const result = await target.run(action, args)
    assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
    assert.equal(target.sim.writes.length, 1)
  }
})

test('camera and slot pre-write refusals are typed and send nothing', async (t) => {
  const record = { tray: 1, material: 'PETG', color: '#112233' }
  const cases: [
    number,
    ExtendedControlAction,
    Record<string, unknown>,
    string,
    ((detail: Record<string, unknown>) => void)?,
  ][] = [
    // Already on, or no report of an off camera: the readback proves nothing.
    [1, 'set_camera_stream', { on: true }, 'state'],
    [0, 'set_camera_stream', { on: true }, 'state'],
    [0, 'set_camera_stream', { on: false }, 'state'],
    [1, 'set_camera_stream', { on: 'yes' }, 'invalid-command'],
    [2, 'set_camera_stream', { on: true }, 'unsupported-action'],
    [1, 'set_filament_slot', record, 'unsupported-action'],
    [2, 'set_filament_slot', { ...record, tray: 4 }, 'invalid-command'],
    [
      2,
      'set_filament_slot',
      { ...record, material: 'WOOD' },
      'invalid-command',
    ],
    [2, 'set_filament_slot', { ...record, color: 'red' }, 'invalid-command'],
    // Unchanged record, busy station and a printer that is not ready.
    [
      2,
      'set_filament_slot',
      { ...record, material: 'PLA', color: '#FFFFFF' },
      'state',
    ],
    [
      2,
      'set_filament_slot',
      record,
      'state',
      (detail) => {
        detail.matlStationInfo = { ...station(), stateAction: 2 }
      },
    ],
    [
      2,
      'set_filament_slot',
      record,
      'state',
      (detail) => {
        detail.status = 'printing'
      },
    ],
  ]
  for (const [index, action, args, refusal, arrange] of cases) {
    const target = await printer(t, MODELS[index]!)
    arrange?.(target.sim.detail)
    const driver = await open(t, target.binding)
    await assert.rejects(
      driver.driver.execute!(action, args, request(target.binding)),
      (error: unknown) =>
        error instanceof DriverRefusalError && error.refusal === refusal,
      `${index} ${action} ${JSON.stringify(args)}`,
    )
    assert.deepEqual(target.sim.writes, [], action)
    await driver.close()
  }
})

test('AD5X trays are published only with the 1-4 slot numbering', async (t) => {
  for (const zeroBased of [false, true]) {
    const target = await printer(t, AD5X)
    if (zeroBased) {
      const value = station()
      value.slotInfos.forEach((slot, index) => (slot.slotId = index))
      target.sim.detail.matlStationInfo = value
    }
    const stop = new AbortController()
    const observation = await new Promise<FlashforgeObservation>((resolve) => {
      const collection = createFlashforgeCollection({
        binding: target.local,
        allowedOrigins: [target.local.origin],
        signal: stop.signal,
        timeoutMs: 1000,
        onObservation: resolve,
        onUnavailable: () => {},
      })
      t.after(async () => {
        stop.abort()
        await collection.done
      })
    })
    stop.abort()
    assert.deepEqual(
      observation.printer.materials,
      zeroBased
        ? undefined
        : [0, 1, 2, 3].map((index) => ({
            slot: `ifs:${index}`,
            materialType: 'PLA',
            colorHex: 'FFFFFFFF',
            active: index === 0,
          })),
    )
    PrinterState.parse(observation.printer)
  }
})

test('the farm names station trays and signs only complete slot records', () => {
  const materials = [{ slot: 'ifs:0', materialType: 'PLA' }, { slot: 'ifs:3' }]
  assert.deepEqual(
    filamentTrays({ materials } as never).map(({ id, label, station }) => ({
      id,
      label,
      station,
    })),
    [
      { id: 0, label: 'Compartimento 1 — PLA', station: true },
      { id: 3, label: 'Compartimento 4', station: true },
    ],
  )
  assert.equal(farmSlotLabel('ifs:2'), 'Compartimento 3')
  assert.deepEqual(buildFilamentSlotArgs('3', 'PETG', '#11aa33'), {
    tray: 3,
    material: 'PETG',
    color: '#11AA33',
  })
  for (const [tray, material, color] of [
    ['', 'PETG', '#11aa33'],
    ['0', '', '#11aa33'],
    ['0', 'PETG', ''],
  ] as const)
    assert.equal(buildFilamentSlotArgs(tray, material, color), undefined)
  assert.match(
    writeDialogDescription('set_filament_slot', {
      tray: 1,
      material: 'PETG',
      color: '#11AA33',
    })!,
    /compartimento 2: material PETG, cor #11AA33\. Nenhum filamento/,
  )
  assert.match(
    writeDialogDescription('set_camera_stream', { on: false })!,
    /^Desligar a transmissão da câmera/,
  )
  assert.equal(writeDialogDescription('pause', {}), undefined)
  // Model-specific writes are never listed as missing on other printers.
  for (const action of unsupportedExtended([]))
    assert.ok(!['set_camera_stream', 'set_filament_slot'].includes(action))
})

test('a version 19 journal upgrades in place and records the new actions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'flashforge-journal-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  closeCommandJournal(openCommandJournal({ directory, clock: () => 1000 }))
  const path = join(directory, 'pause-commands.sqlite')
  const database = new DatabaseSync(path)
  const sql = String(
    database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE name='control_command_actions'",
      )
      .get()!.sql,
  )
  const previous = sql.replace(",'set_camera_stream','set_filament_slot'", '')
  assert.notEqual(previous, sql)
  database.exec(
    `DROP TABLE control_command_actions; ${previous}; INSERT INTO control_command_actions VALUES('retained','pause'); INSERT INTO control_command_restarts VALUES('restart'); PRAGMA user_version=19`,
  )
  database.close()
  closeCommandJournal(openCommandJournal({ directory, clock: () => 1000 }))
  const upgraded = new DatabaseSync(path)
  try {
    assert.equal(
      upgraded.prepare('PRAGMA user_version').get()?.user_version,
      20,
    )
    const insert = upgraded.prepare(
      'INSERT INTO control_command_actions VALUES (?,?)',
    )
    insert.run('camera', 'set_camera_stream')
    insert.run('slot', 'set_filament_slot')
    assert.throws(() => insert.run('other', 'invalid'))
    assert.deepEqual(
      upgraded
        .prepare('SELECT cmd_id FROM control_command_actions ORDER BY cmd_id')
        .all()
        .map((row) => row.cmd_id),
      ['camera', 'retained', 'slot'],
    )
    assert.equal(
      upgraded
        .prepare('SELECT count(*) AS n FROM control_command_restarts')
        .get()?.n,
      1,
    )
  } finally {
    upgraded.close()
  }
})

test('migration 0127 adds both actions and guards its rollback', async () => {
  const catalog = await loadMigrationCatalog()
  const migration = catalog.find(
    (entry) => entry.id === '0127_camera_stream_filament_slot',
  )
  const previous = catalog.find(
    (entry) => entry.id === '0126_clear_hold_capability',
  )
  assert.ok(migration && previous)
  const constraint = (sql: string) =>
    sql
      .split('\n')
      .find((line) =>
        line.includes('ADD CONSTRAINT control_capability_actions'),
      )!
  assert.equal(
    constraint(migration.up),
    constraint(previous.up)
      .replace('BETWEEN 1 AND 34', 'BETWEEN 1 AND 36')
      .replace(
        '"clear_hold"]',
        '"clear_hold","set_camera_stream","set_filament_slot"]',
      ),
  )
  assert.equal(constraint(migration.down), constraint(previous.up))
  assert.ok(
    migration.down.indexOf('RAISE EXCEPTION') <
      migration.down.indexOf('ADD CONSTRAINT control_capability_actions'),
  )
})
