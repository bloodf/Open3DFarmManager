import { getPrinterActionButtons } from '../../apps/farm/app/utils/farm-control.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  createPrinterBindingRegistry,
  provisionBambuPrinter,
  provisionReadonlyPrinter,
} from '../../packages/connector/src/control/printer-binding.ts'
import type { RawMoonrakerObservation } from '../../packages/connector/src/moonraker/subscription.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
function assertNoButtons(printer: ReturnType<typeof snapshot>) {
  assert.deepEqual(printer.controls, [])
  assert.deepEqual(
    getPrinterActionButtons(
      { observation: { state: printer } } as Parameters<
        typeof getPrinterActionButtons
      >[0],
      { kind: 'unavailable' } as Parameters<typeof getPrinterActionButtons>[1],
      true,
      false,
      { wall: 100, mono: 100 },
    ),
    [],
  )
}

const lifecycle = ['pause', 'resume', 'cancel']
const scope = () => ({
  assignment_id: randomUUID(),
  farm_id: randomUUID(),
  agent_id: randomUUID(),
  printer_key: 'printer',
})
function router(allowedOrigins: string[] = []) {
  return createPauseDriverRouter({
    allowedOrigins,
    limits,
    clock: { monotonicNow: () => performance.now() },
    bambuModel: () => 'X1C',
    observe: () => false,
  })
}

function fixture(
  controlsFor?: (assignmentId: string) => readonly ExtendedControlAction[],
  keys = ['printer'],
) {
  const agent = randomUUID()
  const refs = keys.map((printerKey) => ({
    assignmentId: randomUUID(),
    agentId: agent,
    printerKey,
  }))
  const now = 100
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => now,
    ...(controlsFor ? { controlsFor } : {}),
  })
  const received: CompleteFarmSnapshot[] = []
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: agent,
    account_id: 'account',
    key_id: randomUUID(),
    browser_public_key: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' },
    browser_thumbprint: 'test',
    connector_public_key_spki: 'test',
    connector_fingerprint: 'test',
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'test',
    browser_nonce: 'test',
    connector_nonce: 'test',
    issued_at: 0,
    expires_at: 10000,
    commands_enabled: false,
    offer_sha256: 'test',
    answer_sha256: 'test',
    browser_dtls: 'test',
    connector_dtls: 'test',
  }
  const controller = new AbortController()
  function open(deadlineMonoMs = 10000) {
    return source.open({
      binding,
      deadlineMonoMs,
      assignmentRefs: refs,
      signal: controller.signal,
      onComplete(value) {
        received.push(value)
      },
      onUnavailable() {
        assert.fail('Snapshot unexpectedly unavailable')
      },
    })
  }
  function observe(
    key: string,
    epoch = 1,
    times = { webhooks: now, printState: now, progress: now },
    temperatureObservation?: RawMoonrakerObservation['temperatureObservation'],
  ) {
    source.observe({
      printerKey: key,
      epoch,
      printer: {
        printerKey: key,
        state: 'printing',
        progress: 0.2,
        observedAt: 10,
      },
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'printing' },
        virtual_sdcard: { progress: 0.2 },
      },
      fieldObservedAtMonoMs: times,
      receivedAtMonoMs: now,
      ...(temperatureObservation ? { temperatureObservation } : {}),
    })
  }
  return {
    source,
    refs,
    received,
    open,
    observe,
    controller,
    binding,
  }
}

function snapshot(
  t: test.TestContext,
  read: () => readonly ExtendedControlAction[],
) {
  const f = fixture(read)
  t.after(() => {
    f.controller.abort()
    f.source.close()
  })
  f.observe('printer')
  f.open()
  const value = f.received.at(-1)?.printers[0]
  assert.ok(value)
  return value
}

test('Moonraker snapshot advertises every detected driver action and round-trips', async (t) => {
  const remote = await pauseFixture()
  t.after(() => remote.close())
  const driver = router([remote.origin])
  const binding = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  }).provision({ ...scope(), moonraker_origin: remote.origin })
  assert.deepEqual(
    snapshot(t, () => driver.controls(binding)).controls,
    lifecycle,
  )
  await driver.detect(binding)
  const printer = snapshot(t, () => driver.controls(binding))
  assert.deepEqual(printer.controls, [
    ...lifecycle,
    'emergency_stop',
    'set_temperature',
    'set_fan',
    'home',
    'set_light',
    'set_speed',
    'extrude',
    'set_pin',
  ])
  assert.deepEqual(
    PrinterState.parse(JSON.parse(JSON.stringify(printer))),
    printer,
  )
  assert.deepEqual(
    remote.requests.map((request) => request.method),
    ['printer.objects.list', 'server.info'],
  )
})

test('Bambu snapshot follows local control opt-in without opening a connection', (t) => {
  const driver = router()
  for (const control of [true, false]) {
    const binding = provisionBambuPrinter(scope(), {
      printerKey: 'printer',
      serial: 'SYNTHETIC',
      host: '127.0.0.1',
      port: 8883,
      allowedEndpoints: [{ host: '127.0.0.1', port: 8883 }],
      credentialFile: '/nonexistent/synthetic-credentials',
      caFile: '/nonexistent/synthetic-ca',
      control,
    })
    if (!control) assertNoButtons(snapshot(t, () => driver.controls(binding)))
    assert.deepEqual(
      snapshot(t, () => driver.controls(binding)).controls,
      control
        ? [
            ...lifecycle,
            'set_temperature',
            'set_fan',
            'home',
            'set_light',
            'set_speed',
            'start_print',
            'load_filament',
            'unload_filament',
          ]
        : [],
    )
  }
})

test('KobraLink snapshot preserves the registered read-only driver capabilities', (t) => {
  const binding = provisionReadonlyPrinter({
    ...scope(),
    backend: 'kobralink',
    bridgeInstance: 'synthetic-bridge',
    origin: 'http://127.0.0.1:1',
    deviceId: 'synthetic-device',
    id: 'synthetic-id',
    revision: 1,
  })
  const driver = router()
  const printer = snapshot(t, () => driver.controls(binding))
  assertNoButtons(printer)
})

test('controls schema accepts all protocol actions, omission and legacy lists but rejects duplicates and unknown actions', () => {
  const printer = { printerKey: 'printer', state: 'offline', observedAt: 0 }
  for (const controls of [
    undefined,
    [],
    lifecycle,
    ExtendedControlAction.options,
  ]) {
    const value = {
      ...printer,
      ...(controls === undefined ? {} : { controls }),
    }
    assert.deepEqual(
      PrinterState.parse(JSON.parse(JSON.stringify(value))),
      value,
    )
  }
  for (const controls of [
    ['pause', 'pause'],
    ['unknown'],
    [...ExtendedControlAction.options, 'pause'],
  ]) {
    assert.equal(
      PrinterState.safeParse({ ...printer, controls }).success,
      false,
    )
  }
})

test('advertisement is scoped to each snapshot assignment and overrides observation controls', (t) => {
  const f = fixture(
    (id) => (id === f.refs[0]?.assignmentId ? ['home'] : []),
    ['a', 'b'],
  )
  t.after(() => {
    f.controller.abort()
    f.source.close()
  })
  f.observe('a')
  f.source.observe({
    printerKey: 'b',
    epoch: 1,
    printer: {
      printerKey: 'b',
      state: 'offline',
      observedAt: 0,
      controls: ['pause'],
    },
    fieldObservedAtMonoMs: { connection: 100 },
    receivedAtMonoMs: 100,
  })
  f.open()
  assert.deepEqual(
    f.received.at(-1)?.printers.map((printer) => printer.controls),
    [['home'], []],
  )
})
