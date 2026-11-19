import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { createKobraXControl } from '../../packages/connector/src/kobra-x/control.ts'
import { createKobraXFacts } from '../../packages/connector/src/kobra-x/facts.ts'
import {
  bookKobraXUsage,
  createKobraXBookingLedger,
  createSpoolmanUseClient,
} from '../../packages/connector/src/kobra-x/booking.ts'
import { createLoopbackSpoolmanReader } from '../../packages/connector/src/spoolman/http-read.ts'
import {
  installNetworkGuard,
  startKobraXMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

const address = '127.0.0.1'
const recovery = {
  query: () => ({
    ts: String(Date.now()),
    nonce: 'mock-368',
    sign: '0'.repeat(32),
    did: 'fixture',
  }),
  encrypted(token, response) {
    assert.equal(response.code, 200)
    return {
      key: Buffer.from(token.slice(16)),
      iv: Buffer.from(response.data.token),
      ciphertext: Buffer.from(response.data.info, 'base64'),
    }
  },
}
const signed = { beforeSend: () => true }

async function until(check, label = 'condition') {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return
    await delay(20)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function open(t, mockOptions = {}, adapterOptions = {}) {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const usages = []
  const mock = await startKobraXMock({
    reportIntervalMs: 0,
    preparationStepMs: 0,
    ...mockOptions,
  })
  t.after(() => mock.close())
  const adapter = await connectKobraX({
    address,
    printerKey: 'kobra-x-368',
    clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
    recovery,
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
    reconnectMs: 100,
    resultTimeoutMs: 600,
    motionResultTimeoutMs: 600,
    usageSettleMs: 0,
    onJobUsage: (usage) => usages.push(usage),
    ...adapterOptions,
  })
  t.after(() => adapter.close())
  await until(
    () =>
      adapter.snapshot().materials?.length === 4 &&
      adapter.facts().infoState === 'free',
    'initial telemetry',
  )
  return { mock, adapter, usages }
}

/** Publishes of commands (not queries) the adapter sent to the printer. */
function commands(mock) {
  return mock.calls.all
    .filter((message) => /\/printer\/[^/]+\/[^/]+\/[^/]+$/.test(message.topic))
    .filter((message) => !message.topic.includes('/public/'))
    .map((message) => ({
      type: message.topic.split('/').at(-1),
      ...JSON.parse(message.payload.toString()),
    }))
    .filter(
      (message) => message.action !== 'query' && message.action !== 'getInfo',
    )
}

const sent = (mock) => commands(mock).length

/** Make the printer's own answer to the next request of this type not arrive: ack only. */
function dropReport(mock, type) {
  mock.control.faults.addFault({
    fault: { type: 'refuse' },
    topic: new RegExp(`/${type}/report$`),
    method: 'REPORT',
    count: 1,
  })
}

/** Replace the printer's own answer with a refusal for `type`/`action`. */
async function refuseWith(mock, run, type, action, code = 10111) {
  dropReport(mock, type)
  const before = sent(mock)
  const pending = run()
  await until(() => sent(mock) > before, 'request on the wire')
  mock.control.publishTypedReport(type, action, {}, { state: 'failed', code })
  return pending
}

/** Resynchronise the adapter's facts with the mock after earlier cases. */
async function sync(mock, adapter, idle = true) {
  const box = mock.control.getAceState()
  mock.control.publishTypedReport(
    'info',
    'report',
    {
      state: idle ? 'free' : 'busy',
      project: null,
      features: {
        auto_leveling_support: true,
        vibration_compensation_support: true,
        flow_calibration_support: false,
        camera_timelapse_support: true,
      },
      multi_color_box: [box],
    },
    {},
  )
  await until(
    () =>
      adapter.facts().boxes[0]?.loadedSlot === box.loaded_slot &&
      adapter.facts().boxes[0]?.dryingActive ===
        (box.drying_status.status !== 0),
    'facts sync',
  )
}

const outcomeKinds = (outcome) =>
  outcome.kind === 'refused' ? `${outcome.kind}:${outcome.stage}` : outcome.kind

// One case per action: how to run it, which printer message carries it, what
// the confirmed effect looks like on the mock and the state it needs first.
const idleCases = [
  {
    name: 'light on',
    type: 'light',
    action: 'control',
    run: (c) => c.setLight(true, signed),
  },
  {
    name: 'fan speed (idle)',
    type: 'fan',
    action: 'setSpeed',
    run: (c) => c.setFan(60, signed),
  },
  {
    name: 'home all axes',
    type: 'axis',
    action: 'move',
    run: (c) => c.home(signed),
  },
  {
    name: 'jog X plus',
    type: 'axis',
    action: 'move',
    run: (c) => c.jog('x', 'plus', signed),
  },
  {
    name: 'idle heating of the nozzle',
    type: 'tempature',
    action: 'set',
    run: (c) => c.setTemperature('extruder', 180, signed),
  },
  {
    name: 'idle heating of the bed',
    type: 'tempature',
    action: 'set',
    run: (c) => c.setTemperature('bed', 55, signed),
  },
  {
    name: 'ACE feed',
    type: 'multiColorBox',
    action: 'feed',
    run: (c) => c.ace.feed(1, signed),
    after: (mock) => assert.equal(mock.control.getAceState().loaded_slot, 1),
  },
  {
    name: 'ACE retract',
    type: 'multiColorBox',
    action: 'retract',
    prepare: (mock) => mock.control.aceFeed(2),
    run: (c) => c.ace.retract(signed),
    after: (mock) => assert.equal(mock.control.getAceState().loaded_slot, -1),
  },
  {
    name: 'ACE drying start',
    type: 'multiColorBox',
    action: 'startDrying',
    prepare: (mock) => mock.control.aceStopDrying(),
    run: (c) => c.ace.startDrying({ targetCelsius: 50, minutes: 120 }, signed),
    after: (mock) =>
      assert.equal(mock.control.getAceState().drying_status.target_temp, 50),
  },
  {
    name: 'ACE drying stop',
    type: 'multiColorBox',
    action: 'stopDrying',
    prepare: (mock) => mock.control.aceStartDrying({ targetTemp: 45 }),
    run: (c) => c.ace.stopDrying(signed),
    after: (mock) =>
      assert.equal(mock.control.getAceState().drying_status.status, 0),
  },
  {
    name: 'ACE auto-feed',
    type: 'multiColorBox',
    action: 'setAutoFeed',
    run: (c) => c.ace.setAutoFeed(false, signed),
    after: (mock) => assert.equal(mock.control.getAceState().auto_feed, 0),
  },
  {
    name: 'ACE slot edit',
    type: 'multiColorBox',
    action: 'editSlot',
    run: (c) =>
      c.ace.editSlot(
        2,
        { materialName: 'ASA', type: 'ASA', color: [10, 20, 30] },
        signed,
      ),
    after: (mock) => {
      const slot = mock.control.getAceState().slots[2]
      assert.equal(slot.material_name, 'ASA')
      assert.deepEqual(slot.color, [10, 20, 30])
    },
  },
  {
    name: 'file list',
    type: 'file',
    action: 'listLocal',
    run: (c) => c.files.list(),
  },
  {
    name: 'file details',
    type: 'file',
    action: 'fileDetails',
    run: (c) => c.files.details('cube.gcode'),
  },
  {
    name: 'file delete',
    type: 'file',
    action: 'deleteLocal',
    run: (c) => c.files.remove('cube.gcode', signed),
    after: (mock) =>
      assert.equal(
        mock.control.getFiles().some((f) => f.filename === 'cube.gcode'),
        false,
      ),
  },
]

for (const entry of idleCases) {
  test(`E16.21 ${entry.name}: confirmed, refused and ack-only outcomes`, async (t) => {
    const { mock, adapter } = await open(t)
    mock.control.seedFile('cube.gcode', 'G28\n')
    const control = adapter.control
    const prepare = async () => {
      entry.prepare?.(mock)
      await sync(mock, adapter)
    }
    // Confirmed: the printer's own report settles the request.
    await prepare()
    const confirmed = await entry.run(control)
    assert.equal(confirmed.kind, 'confirmed', entry.name)
    assert.equal(confirmed.report.type, entry.type)
    assert.ok(
      commands(mock).some(
        (m) => m.type === entry.type && m.action === entry.action,
      ),
      `${entry.name} reached the wire as ${entry.type}/${entry.action}`,
    )
    entry.after?.(mock)

    // Refused: a failed report with a non-success code.
    mock.control.seedFile('cube.gcode', 'G28\n')
    await prepare()
    const refused = await refuseWith(
      mock,
      () => entry.run(control),
      entry.type,
      entry.action,
    )
    assert.deepEqual(
      { kind: refused.kind, stage: refused.stage, code: refused.code },
      { kind: 'refused', stage: 'printer', code: 10111 },
      entry.name,
    )

    // Ack-only: the acknowledgement arrived and no report followed.
    mock.control.seedFile('cube.gcode', 'G28\n')
    await prepare()
    dropReport(mock, entry.type)
    const received = await entry.run(control)
    assert.equal(received.kind, 'received', entry.name)
  })
}

test('E16.21 pause, resume, stop, speed, fan and skip objects while printing: confirmed, refused, ack-only', async (t) => {
  const { mock, adapter } = await open(t)
  const control = adapter.control
  const cases = [
    {
      type: 'print',
      action: 'pause',
      state: 'printing',
      run: () => control.pause(signed),
    },
    {
      type: 'print',
      action: 'resume',
      state: 'paused',
      run: () => control.resume(signed),
    },
    {
      type: 'print',
      action: 'stop',
      state: 'printing',
      run: () => control.stop(signed),
    },
    {
      type: 'print',
      action: 'update',
      state: 'printing',
      run: () => control.setSpeed('sport', signed),
    },
    {
      type: 'print',
      action: 'update',
      state: 'printing',
      run: () => control.setFan(40, signed),
    },
    {
      type: 'skip',
      action: 'set',
      state: 'printing',
      run: () => control.skipObjects([3, 4], signed),
    },
  ]
  for (const entry of cases) {
    const label = `${entry.action}/${entry.type}`
    const prepare = async () => {
      await mock.control.startPrint('job.gcode', { preparationPhases: [] })
      if (entry.state === 'paused') mock.control.setJobPhase('paused')
      await until(
        () => adapter.snapshot().state === entry.state,
        `${entry.state} state`,
      )
    }
    await prepare()
    const confirmed = await entry.run()
    assert.equal(confirmed.kind, 'confirmed', label)
    await prepare()
    const refused = await refuseWith(mock, entry.run, entry.type, entry.action)
    assert.equal(refused.kind, 'refused', label)
    assert.equal(refused.stage, 'printer', label)
    await prepare()
    dropReport(mock, entry.type)
    assert.equal((await entry.run()).kind, 'received', label)
  }
  assert.deepEqual(
    commands(mock)
      .filter((m) => m.action === 'update' && m.data.settings?.print_speed_mode)
      .map((m) => m.data.settings.print_speed_mode),
    [3, 3, 3],
  )
})

test('E16.21 actions the printer cannot do in its state are refused before anything is published', async (t) => {
  const { mock, adapter } = await open(t)
  const control = adapter.control
  mock.control.seedFile('cube.gcode', 'G28\n')
  const refusedLocally = async (promise, reason) => {
    const before = sent(mock)
    const outcome = await promise
    assert.deepEqual(
      { kind: outcome.kind, stage: outcome.stage, reason: outcome.reason },
      { kind: 'refused', stage: 'local', reason },
    )
    assert.equal(sent(mock), before, `${reason} published nothing`)
  }

  // Idle: lifecycle, speed and object skipping have nothing to act on.
  await sync(mock, adapter)
  await refusedLocally(control.pause(signed), 'not-printing')
  await refusedLocally(control.resume(signed), 'not-paused')
  await refusedLocally(control.stop(signed), 'no-job')
  await refusedLocally(control.setSpeed('sport', signed), 'not-printing')
  await refusedLocally(control.skipObjects([1], signed), 'no-job')
  await refusedLocally(control.ace.retract(signed), 'nothing-loaded')
  await refusedLocally(control.ace.stopDrying(signed), 'not-drying')
  await refusedLocally(control.ace.feed(9, signed), 'unknown-slot')
  await refusedLocally(
    control.ace.editSlot(9, { type: 'PLA' }, signed),
    'unknown-slot',
  )
  await refusedLocally(
    control.setTemperature('extruder', 400, signed),
    'invalid-value',
  )
  await refusedLocally(
    control.setTemperature('chamber', 30, signed),
    'invalid-value',
  )
  await refusedLocally(control.setFan(101, signed), 'invalid-value')
  await refusedLocally(
    control.ace.startDrying({ targetCelsius: 90, minutes: 60 }, signed),
    'invalid-value',
  )
  await refusedLocally(
    control.files.remove('../x.gcode', signed),
    'invalid-filename',
  )
  // A start for a file the printer does not hold is refused after a read-only listing.
  const missing = await control.files.start(
    { filename: 'missing.gcode' },
    signed,
  )
  assert.equal(missing.reason, 'file-not-on-printer')
  assert.equal(
    commands(mock).some((m) => m.type === 'print'),
    false,
  )

  // No signed authorization, no send.
  await refusedLocally(
    control.setLight(true, { beforeSend: () => false }),
    'not-authorized',
  )
  await refusedLocally(
    control.home({
      beforeSend() {
        throw new Error('guard failed')
      },
    }),
    'not-authorized',
  )
  await refusedLocally(control.home(undefined), 'not-authorized')
  await refusedLocally(
    control.execute(
      'home',
      { axes: ['x', 'y', 'z'] },
      { beforeSend: () => false },
    ),
    'not-authorized',
  )
  const aborted = new AbortController()
  aborted.abort()
  await refusedLocally(
    control.setLight(true, { beforeSend: () => true, signal: aborted.signal }),
    'aborted',
  )

  // Printing: no motion, heating, ACE or slot changes, and no second job.
  mock.control.setState('printing')
  mock.control.setJobPhase('printing')
  await until(() => adapter.snapshot().state === 'printing', 'printing')
  await refusedLocally(control.home(signed), 'job-active')
  await refusedLocally(control.jog('z', 'minus', signed), 'job-active')
  await refusedLocally(control.setTemperature('bed', 60, signed), 'job-active')
  await refusedLocally(control.ace.feed(0, signed), 'job-active')
  await refusedLocally(control.ace.retract(signed), 'job-active')
  await refusedLocally(
    control.ace.startDrying({ targetCelsius: 50, minutes: 60 }, signed),
    'job-active',
  )
  await refusedLocally(control.ace.setAutoFeed(true, signed), 'job-active')
  await refusedLocally(
    control.ace.editSlot(0, { type: 'PLA' }, signed),
    'job-active',
  )
  await refusedLocally(
    control.files.start({ filename: 'cube.gcode' }, signed),
    'job-active',
  )
  await refusedLocally(control.resume(signed), 'not-paused')
  // A job running and a file in use cannot be deleted.
  mock.control.publishTypedReport(
    'print',
    'start',
    { filename: 'cube.gcode', taskid: '-1' },
    { state: 'printing' },
  )
  await until(() => adapter.facts().filename === 'cube.gcode', 'job file')
  await refusedLocally(
    control.files.remove('cube.gcode', signed),
    'file-in-use',
  )

  // Paused is not idle either: still no motion.
  mock.control.setState('paused')
  mock.control.setJobPhase('paused')
  await until(() => adapter.snapshot().state === 'paused', 'paused')
  await refusedLocally(control.home(signed), 'job-active')

  // Disconnected: everything is refused, reads included.
  await mock.control.disconnectClients()
  await until(() => adapter.snapshot().state === 'offline', 'offline')
  await refusedLocally(control.setLight(true, signed), 'printer-offline')
  await refusedLocally(control.files.list(), 'printer-offline')
})

test('E16.21 signed control entry point maps farm actions and refuses what it cannot carry', async (t) => {
  const { mock, adapter } = await open(t)
  const control = adapter.control
  await sync(mock, adapter)
  assert.deepEqual([...control.advertised()].sort(), [
    'cancel',
    'home',
    'load_filament',
    'pause',
    'resume',
    'set_fan',
    'set_light',
    'set_speed',
    'set_temperature',
    'start_print',
    'unload_filament',
  ])
  const ran = async (action, args) =>
    (await control.execute(action, args, signed)).kind
  assert.equal(await ran('set_light', { on: true }), 'confirmed')
  assert.equal(await ran('set_fan', { fan: 'part', percent: 30 }), 'confirmed')
  assert.equal(await ran('home', { axes: ['x', 'y', 'z'] }), 'confirmed')
  assert.equal(
    await ran('set_temperature', { heater: 'bed', target_c: 50 }),
    'confirmed',
  )
  assert.equal(await ran('load_filament', { tray: 3 }), 'confirmed')
  await sync(mock, adapter)
  assert.equal(await ran('unload_filament', {}), 'confirmed')
  const reason = async (action, args) =>
    (await control.execute(action, args, signed)).reason
  assert.equal(await reason('emergency_stop', {}), 'unsupported-action')
  assert.equal(await reason('firmware_restart', {}), 'unsupported-action')
  assert.equal(await reason('run_macro', { name: 'X' }), 'unsupported-action')
  assert.equal(
    await reason('set_fan', { fan: 'aux', percent: 10 }),
    'unsupported-fan',
  )
  assert.equal(
    await reason('set_temperature', { heater: 'chamber', target_c: 30 }),
    'unsupported-heater',
  )
  assert.equal(await reason('home', { axes: ['x'] }), 'unsupported-axes')
  assert.equal(await reason('load_filament', {}), 'tray-required')
  assert.equal(await reason('set_light', { on: 'yes' }), 'invalid-command')
  assert.equal(await reason('pause', {}), 'state')
})

test('E16.21 print start: upload, slot mapping, task settings and the printer-ended task watch', async (t) => {
  const { mock, adapter } = await open(t, { preparationPhases: [] })
  const control = adapter.control
  await sync(mock, adapter)

  // Upload over /gcode_upload.
  const uploaded = await control.files.upload(
    {
      filename: 'plate.gcode',
      content: new Blob(['G28\nG1 X10\n'], { type: 'text/plain' }),
    },
    signed,
  )
  assert.equal(uploaded.kind, 'confirmed')
  assert.deepEqual(uploaded.data, { filename: 'plate.gcode' })
  assert.equal(mock.control.getFiles()[0].content.toString(), 'G28\nG1 X10\n')
  assert.equal(
    (
      await control.files.upload(
        { filename: 'bad/name.gcode', content: new Blob(['x']) },
        signed,
      )
    ).reason,
    'invalid-filename',
  )
  assert.equal(
    (
      await control.files.upload(
        { filename: 'plate.gcode', content: new Blob(['x']) },
        { beforeSend: () => false },
      )
    ).reason,
    'not-authorized',
  )
  mock.control.faults.addFault({
    fault: { type: 'refuse', statusCode: 500 },
    path: '/gcode_upload',
    count: 1,
  })
  const refusedUpload = await control.files.upload(
    { filename: 'again.gcode', content: new Blob(['x']) },
    signed,
  )
  assert.deepEqual(
    {
      kind: refusedUpload.kind,
      stage: refusedUpload.stage,
      code: refusedUpload.code,
    },
    { kind: 'refused', stage: 'printer', code: 500 },
  )

  // Start: filepath "/", the uploaded name, slot mapping, task settings.
  const started = await control.files.start(
    {
      filename: 'plate.gcode',
      slotMapping: [
        { filament: 0, slot: 1 },
        { filament: 1, slot: 3 },
      ],
      settings: {
        autoLeveling: true,
        vibrationCompensation: false,
        flowCalibration: true,
        timelapse: true,
      },
      watchMs: 300,
    },
    signed,
  )
  assert.equal(started.kind, 'confirmed')
  const start = commands(mock).findLast(
    (m) => m.type === 'print' && m.action === 'start',
  )
  assert.equal(start.data.filepath, '/')
  assert.equal(start.data.filename, 'plate.gcode')
  assert.equal(start.data.taskid, '-1')
  assert.deepEqual(start.data.ams_settings.ams_box_mapping, [
    { paint_index: 0, ams_index: 1 },
    { paint_index: 1, ams_index: 3 },
  ])
  assert.deepEqual(start.data.task_settings, {
    auto_leveling: 1,
    vibration_compensation: 0,
    // The printer's features mark flow calibration unsupported: dropped.
    timelapse: { status: 1, count: 0, type: 64 },
  })
  await until(() => adapter.snapshot().state === 'printing', 'job running')
  mock.control.finishPrint()
  await until(() => adapter.snapshot().state === 'idle', 'finished')

  // Invalid mapping is refused before the file list or the start.
  await sync(mock, adapter)
  const before = sent(mock)
  assert.equal(
    (
      await control.files.start(
        { filename: 'plate.gcode', slotMapping: [{ filament: 0, slot: 9 }] },
        signed,
      )
    ).reason,
    'unknown-slot',
  )
  assert.equal(
    (
      await control.files.start(
        {
          filename: 'plate.gcode',
          slotMapping: [
            { filament: 0, slot: 0 },
            { filament: 0, slot: 1 },
          ],
        },
        signed,
      )
    ).reason,
    'invalid-slot-mapping',
  )
  assert.equal(sent(mock), before)

  // The printer ends the task by itself shortly after the start report.
  mock.control.seedFile('trap.gcode', 'G28\n')
  const trapped = control.files.start(
    { filename: 'trap.gcode', watchMs: 1500 },
    signed,
  )
  await until(
    () => commands(mock).some((m) => m.data?.filename === 'trap.gcode'),
    'trap start',
  )
  setTimeout(() => mock.control.failPrint(10111, 'abnormal end of task'), 150)
  const ended = await trapped
  assert.deepEqual(
    {
      kind: ended.kind,
      stage: ended.stage,
      reason: ended.reason,
      code: ended.code,
    },
    {
      kind: 'refused',
      stage: 'printer',
      reason: 'task-ended-by-printer',
      code: 10111,
    },
  )
  await until(() => adapter.snapshot().state === 'error', 'error state')

  // Start refused by the printer, and an acknowledged start without result.
  await sync(mock, adapter)
  const refusedStart = await refuseWith(
    mock,
    () =>
      control.files.start({ filename: 'plate.gcode', watchMs: 100 }, signed),
    'print',
    'start',
    10100,
  )
  assert.deepEqual(
    { kind: refusedStart.kind, code: refusedStart.code },
    { kind: 'refused', code: 10100 },
  )
  mock.control.setState('idle')
  await sync(mock, adapter)
  dropReport(mock, 'print')
  const ackOnly = await control.files.start(
    { filename: 'plate.gcode', watchMs: 100 },
    signed,
  )
  assert.equal(ackOnly.kind, 'received')
})

test('E16.21 upload without a readable result is received, not success', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({ reportIntervalMs: 0 })
  t.after(() => mock.close())
  const facts = createKobraXFacts()
  const control = createKobraXControl({
    requests: { send: () => assert.fail('upload sends no MQTT request') },
    facts,
    state: () => 'idle',
    address,
    httpPort: mock.httpPort,
    token: mock.credentials.token,
    fetch: async () => new Response('stored', { status: 200 }),
  })
  const outcome = await control.files.upload(
    { filename: 'x.gcode', content: new Blob(['G28']) },
    signed,
  )
  assert.equal(outcome.kind, 'received')
  const down = createKobraXControl({
    requests: {},
    facts,
    state: () => 'idle',
    address,
    httpPort: mock.httpPort,
    token: mock.credentials.token,
    fetch: async () => {
      throw new Error('network')
    },
  })
  assert.equal(
    (
      await down.files.upload(
        { filename: 'x.gcode', content: new Blob(['G28']) },
        signed,
      )
    ).kind,
    'unanswered',
  )
})

test('E16.21 one command at a time; a foreign report of the same action settles, a wrong one does not', async (t) => {
  const { mock, adapter } = await open(t)
  const control = adapter.control
  await sync(mock, adapter)
  // The reply is held back so two commands overlap.
  mock.control.faults.addFault({
    fault: { type: 'delay', delayMs: 250 },
    topic: /\/light\/report$/,
    method: 'REPORT',
    count: 1,
  })
  const first = control.setLight(true, signed)
  await until(() => sent(mock) === 1, 'first command')
  const second = await control.setLight(false, signed)
  assert.deepEqual(
    { kind: second.kind, reason: second.reason },
    { kind: 'refused', reason: 'busy' },
  )
  assert.equal((await first).kind, 'confirmed')

  // A report that does not show the requested value never confirms it.
  mock.control.faults.addFault({
    fault: { type: 'refuse' },
    topic: /\/light\/report$/,
    method: 'REPORT',
    count: 1,
  })
  const waiting = control.setLight(true, signed)
  await until(
    () => sent(mock) === 2 || commands(mock).length >= 2,
    'second light command',
  )
  mock.control.simulateSecondClientReport('light', 'control', { status: 0 })
  assert.equal((await waiting).kind, 'received')
})

test('E16.21 filament usage per job is measured on the ACE and booked once through Spoolman', async (t) => {
  const { mock, adapter, usages } = await open(t)
  await sync(mock, adapter)
  const boxAt = (percents) => ({
    ...mock.control.getAceState(),
    slots: mock.control.getAceState().slots.map((slot, index) => ({
      ...slot,
      consumables_percent: percents[index],
    })),
  })
  mock.control.publishTypedReport('multiColorBox', 'getInfo', {
    multi_color_box: [boxAt([100, 80, 70, 50])],
  })
  await until(
    () => adapter.facts().boxes[0]?.slots[1]?.remainingPercent === 80,
    'baseline',
  )
  mock.control.seedFile('job.gcode', 'G28\n')
  const started = await adapter.control.files.start(
    { filename: 'job.gcode', watchMs: 100 },
    signed,
  )
  assert.equal(started.kind, 'confirmed')
  await until(() => adapter.facts().jobActive, 'job active')
  mock.control.publishTypedReport('multiColorBox', 'getInfo', {
    multi_color_box: [boxAt([100, 72, 66, 50])],
  })
  await until(
    () => adapter.facts().boxes[0]?.slots[1]?.remainingPercent === 72,
    'consumed',
  )
  mock.control.finishPrint()
  await until(() => usages.length === 1, 'usage emitted')
  const [usage] = usages
  assert.equal(usage.outcome, 'completed')
  assert.equal(usage.filename, 'job.gcode')
  assert.deepEqual(
    usage.slots.map(({ slot, grams, materialType }) => ({
      slot,
      grams,
      materialType,
    })),
    [
      { slot: 1, grams: 80, materialType: 'PLA' },
      { slot: 2, grams: 40, materialType: 'PETG' },
    ],
  )

  // The existing Spoolman provider supplies the inventory; booking writes /use.
  const uses = []
  const spoolman = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/v1/spool') {
      const item = (id, remaining) => ({
        id,
        filament: { id, name: 'PLA', material: 'PLA', color_hex: 'FFFFFF' },
        initial_weight: 1000,
        used_weight: 1000 - remaining,
        remaining_weight: remaining,
        archived: false,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          url.searchParams.get('offset') === '0'
            ? [item(11, 900), item(12, 20)]
            : [],
        ),
      )
      return
    }
    const match = /^\/api\/v1\/spool\/(\d+)\/use$/.exec(url.pathname)
    if (request.method === 'PUT' && match) {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        uses.push({ id: Number(match[1]), ...JSON.parse(body) })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      return
    }
    response.writeHead(404).end()
  })
  spoolman.listen(0, '127.0.0.1')
  await once(spoolman, 'listening')
  t.after(() => spoolman.close())
  const origin = `http://127.0.0.1:${spoolman.address().port}`
  const inventory = await createLoopbackSpoolmanReader({
    origin,
    timeoutMs: 2000,
    context: {
      farmId: '11111111-1111-4111-8111-111111111111',
      serviceId: '22222222-2222-4222-8222-222222222222',
      limit: 200,
    },
  })()
  const snapshot = { kind: 'observed', inventory, ageMs: 0 }
  const ledger = createKobraXBookingLedger()
  const use = createSpoolmanUseClient({ origin })
  const booked = await bookKobraXUsage({
    usage,
    slotSpools: { 1: 11, 2: 12, 3: 13 },
    snapshot,
    use,
    ledger,
  })
  assert.deepEqual(booked, [
    { slot: 1, spoolId: 11, grams: 80, kind: 'booked' },
    // Spool 12 holds 20 g: a 40 g booking means the mapping is wrong.
    { slot: 2, kind: 'skipped', reason: 'exceeds-remaining' },
  ])
  assert.deepEqual(uses, [{ id: 11, use_weight: 80 }])
  const again = await bookKobraXUsage({
    usage,
    slotSpools: { 1: 11 },
    snapshot,
    use,
    ledger,
  })
  assert.deepEqual(again, [
    { slot: 1, kind: 'skipped', reason: 'already-booked' },
    { slot: 2, kind: 'skipped', reason: 'no-spool' },
  ])
  assert.equal(uses.length, 1)
  const unavailable = await bookKobraXUsage({
    usage,
    slotSpools: { 1: 11 },
    snapshot: { kind: 'unavailable', inventory: null, ageMs: null },
    use,
    ledger: createKobraXBookingLedger(),
  })
  assert.equal(unavailable[0].reason, 'inventory-unavailable')
  assert.equal(
    (
      await bookKobraXUsage({
        usage,
        slotSpools: {},
        snapshot,
        use,
        ledger: createKobraXBookingLedger(),
      })
    )[0].reason,
    'no-spool',
  )
  assert.throws(() =>
    createSpoolmanUseClient({ origin: 'http://user:pw@127.0.0.1:1' }),
  )
})
