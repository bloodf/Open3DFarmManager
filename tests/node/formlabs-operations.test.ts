import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test, type TestContext } from 'node:test'
import {
  connectFormlabsOperations,
  formlabsFamily,
  formlabsOperationSupport,
} from '../../packages/connector/src/formlabs/operations.ts'
import { startFormlabsSimulator } from '../../packages/sim-tools/src/formlabs-simulator.ts'

// Machine type ids other than FORM-4-0 are synthetic placeholders. The adapter
// takes them from the host and never hardcodes them.
const MODELS = [
  { model: 'Form 4', machine: 'FORM-4-0' },
  { model: 'Form 4L', machine: 'SIM-FORM-4L' },
  { model: 'Form 3', machine: 'SIM-FORM-3' },
  { model: 'Form 3+', machine: 'SIM-FORM-3-PLUS' },
  { model: 'Form 3L', machine: 'SIM-FORM-3L' },
]
const FILE = '/synthetic/part.form'
const JOB = { file: FILE, jobName: 'Synthetic job' }
const PRINT = 'POST /v1/scene/print/'
const IDLE = { queue: [], printing: null }

async function setup(
  t: TestContext,
  { model, machine } = MODELS[0]!,
  printer: Parameters<
    Awaited<ReturnType<typeof startFormlabsSimulator>>['updatePrinter']
  >[1] = {},
) {
  const sim = await startFormlabsSimulator()
  t.after(sim.close)
  sim.addPrinter({
    id: 'SimSerial',
    productName: model,
    machineTypeIds: [machine],
    ...printer,
  })
  sim.addFormFile(FILE, [machine])
  const adapter = connectFormlabsOperations({
    host: '127.0.0.1',
    port: sim.port,
    deviceId: 'SimSerial',
    now: () => 100,
    confirmReads: 2,
    confirmIntervalMs: 1,
  })
  const sentPrints = () => sim.requests.filter((r) => r === PRINT).length
  const state = () => sim.printerState('SimSerial')
  return { sim, adapter, sentPrints, state }
}

for (const entry of MODELS) {
  test(`${entry.model}: status reports the documented device fields`, async (t) => {
    const { adapter } = await setup(t, entry)
    const status = await adapter.status()
    assert.equal(status.model, entry.model)
    assert.equal(status.family, formlabsFamily(entry.model))
    assert.equal(status.remainingMs, 0)
    assert.equal(status.readyToPrintNow, true)
    assert.equal(status.tankMaterialCode, 'FLGPBK05')
    assert.deepEqual(status.cartridges, [
      {
        id: 'sim-cartridge',
        materialCode: 'FLGPBK05',
        estimatedDispensedMl: 125.5,
        originalMl: 1000,
      },
    ])
    assert.equal(status.retrievedAt, 100)
    assert.equal(status.printerObservedAt, null)
    assert.equal(
      status.formAutoStatusText !== undefined,
      status.family === 'form-3',
    )
  })

  test(`${entry.model}: upload queues without starting`, async (t) => {
    const { sim, adapter, state } = await setup(t, entry)
    const result = await adapter.upload(JOB)
    assert.deepEqual(state(), {
      printing: null,
      queue: [
        {
          jobId: result.ok ? result.jobId : '',
          jobName: JOB.jobName,
          machineType: entry.machine,
        },
      ],
    })
    assert.equal(result.outcome, 'accepted')
    assert.equal((await adapter.status()).remainingMs, 0)
    assert.equal(sim.openSceneCount(), 0)
  })

  test(`${entry.model}: start prints and the host reports it`, async (t) => {
    const { sim, adapter, state } = await setup(t, entry)
    const result = await adapter.start(JOB)
    assert.equal(state().printing?.jobName, JOB.jobName)
    assert.deepEqual(state().queue, [])
    const status = await adapter.status()
    assert.equal(status.remainingMs, 3_600_000)
    assert.equal(status.readyToPrintNow, false)
    assert.deepEqual(result, {
      ok: true,
      outcome: 'printing',
      jobId: state().printing!.jobId,
      remainingMs: 3_600_000,
      confirmation: 'host-status',
    })
    assert.equal(sim.openSceneCount(), 0)
  })
}

test('upload sends print_now false even when the printer would auto-start', async (t) => {
  const { sim, adapter, state } = await setup(t)
  await adapter.upload(JOB)
  assert.equal(state().printing, null)
  assert.equal((sim.printBodies[0] as { print_now: unknown }).print_now, false)
})

test('upload may queue behind a running print', async (t) => {
  const { adapter, state } = await setup(t)
  await adapter.start(JOB)
  await adapter.upload({ ...JOB, jobName: 'Next job' })
  assert.equal(state().printing?.jobName, JOB.jobName)
  assert.deepEqual(
    state().queue.map((job) => job.jobName),
    ['Next job'],
  )
})

for (const [name, patch, reason] of [
  ['not ready to print now', { autoStart: false }, 'not-ready'],
  ['a remote device', { connectionType: 'REMOTE' }, 'not-local-connection'],
  ['a virtual device', { connectionType: 'VIRTUAL' }, 'not-local-connection'],
  ['a disconnected device', { connected: false }, 'device-not-found'],
  [
    'an unverified model',
    { productName: 'Form Studio 1' },
    'unsupported-model',
  ],
] as const) {
  test(`start is refused for ${name} and the printer stays idle`, async (t) => {
    const { adapter, sentPrints, state } = await setup(t, MODELS[0], patch)
    const result = await adapter.start(JOB)
    assert.deepEqual(state(), IDLE)
    assert.deepEqual(result, { ok: false, outcome: 'refused', reason })
    assert.equal(sentPrints(), 0)
  })
}

test('start is refused on a printing printer and the first job continues', async (t) => {
  const { adapter, sentPrints, state } = await setup(t)
  await adapter.start(JOB)
  const before = state()
  const result = await adapter.start({ ...JOB, jobName: 'Second job' })
  assert.deepEqual(state(), before)
  assert.equal(!result.ok && result.reason, 'printer-busy')
  assert.equal(sentPrints(), 1)
})

test('readiness is checked again after the file is opened', async (t) => {
  const { sim, adapter, sentPrints, state } = await setup(t)
  sim.afterSceneOpen(() => sim.updatePrinter('SimSerial', { autoStart: false }))
  const result = await adapter.start(JOB)
  assert.deepEqual(state(), IDLE)
  assert.equal(!result.ok && result.reason, 'not-ready')
  assert.equal(sentPrints(), 0)
  assert.equal(sim.openSceneCount(), 0)
})

for (const [name, machines, reason] of [
  ['another printer type', ['SIM-OTHER'], 'incompatible-scene'],
  ['two build volumes', ['FORM-4-0', 'FORM-4-0'], 'multiple-scenes'],
  ['no build volume', [], 'multiple-scenes'],
] as const) {
  test(`a .form file with ${name} is not sent`, async (t) => {
    const { sim, adapter, sentPrints, state } = await setup(t)
    sim.addFormFile(FILE, [...machines])
    const result = await adapter.upload(JOB)
    assert.deepEqual(state(), IDLE)
    assert.equal(!result.ok && result.reason, reason)
    assert.equal(sentPrints(), 0)
    assert.equal(sim.openSceneCount(), 0)
  })
}

test('invalid files and job names are refused before any request', async (t) => {
  const { sim, adapter, state } = await setup(t)
  for (const [request, reason] of [
    [{ ...JOB, file: 'part.form' }, 'invalid-file'],
    [{ ...JOB, file: '/synthetic/part.stl' }, 'invalid-file'],
    [{ ...JOB, jobName: '  ' }, 'invalid-job-name'],
    [{ ...JOB, jobName: 'a\nb' }, 'invalid-job-name'],
  ] as const) {
    const result = await adapter.upload(request)
    assert.equal(!result.ok && result.reason, reason)
  }
  assert.deepEqual(state(), IDLE)
  assert.deepEqual(sim.requests, [])
})

test('a file the host cannot open is refused with the host code', async (t) => {
  const { adapter, sentPrints, state } = await setup(t)
  const result = await adapter.upload({
    ...JOB,
    file: '/synthetic/missing.form',
  })
  assert.deepEqual(state(), IDLE)
  assert.deepEqual(result, {
    ok: false,
    outcome: 'refused',
    reason: 'host-rejected',
    code: 'OPERATION_FAILED',
  })
  assert.equal(sentPrints(), 0)
})

test('a non-loopback host cannot receive file paths', async () => {
  const adapter = connectFormlabsOperations({
    host: '192.168.0.2',
    port: 44388,
    deviceId: 'SimSerial',
  })
  for (const result of [await adapter.upload(JOB), await adapter.start(JOB)])
    assert.equal(!result.ok && result.reason, 'host-not-loopback')
})

test('only one write runs at a time', async (t) => {
  const { adapter, sentPrints, state } = await setup(t)
  const [first, second] = await Promise.all([
    adapter.upload(JOB),
    adapter.upload({ ...JOB, jobName: 'Overlap' }),
  ])
  assert.deepEqual(
    state().queue.map((job) => job.jobName),
    [JOB.jobName],
  )
  assert.equal(first.outcome, 'accepted')
  assert.equal(!second.ok && second.reason, 'operation-in-flight')
  assert.equal(sentPrints(), 1)
})

for (const [kind, applied] of [
  ['drop-before', false],
  ['drop-after', true],
] as const) {
  for (const operation of ['upload', 'start'] as const) {
    test(`${operation} with ${kind} is uncertain and sent once`, async (t) => {
      const { sim, adapter, sentPrints, state } = await setup(t)
      sim.failNext(PRINT, { kind })
      const result = await adapter[operation](JOB)
      const jobs = [...state().queue, state().printing].filter(Boolean)
      assert.equal(jobs.length, applied ? 1 : 0)
      assert.deepEqual(result, {
        ok: false,
        outcome: 'uncertain',
        reason: 'no-usable-response',
      })
      assert.equal(sentPrints(), 1)
      // The scene may still be in use, so it is not deleted.
      assert.equal(sim.openSceneCount(), 1)
    })
  }
}

for (const [status, code, expected] of [
  [400, 'OPERATION_FAILED', 'uncertain'],
  [500, 'UNKNOWN_FAILURE', 'uncertain'],
  [500, 'INPUT_ERROR', 'uncertain'],
  [409, 'OPERATION_IN_PROGRESS', 'uncertain'],
  [400, 'INPUT_ERROR', 'refused'],
  [413, 'PAYLOAD_TOO_LARGE', 'refused'],
] as const) {
  test(`print reply ${status} ${code} is ${expected}`, async (t) => {
    const { sim, adapter, sentPrints, state } = await setup(t)
    sim.failNext(PRINT, { kind: 'reply', status, code })
    const result = await adapter.upload(JOB)
    assert.deepEqual(state(), IDLE)
    assert.equal(result.outcome, expected)
    assert.equal(!result.ok && result.code, code)
    assert.equal(sentPrints(), 1)
  })
}

test('a start the host never reports stays uncertain', async (t) => {
  const { adapter, sentPrints, state } = await setup(t, MODELS[0], {
    reportsStart: false,
  })
  const result = await adapter.start(JOB)
  assert.deepEqual(result, {
    ok: false,
    outcome: 'uncertain',
    reason: 'start-not-reported',
    jobId: state().printing!.jobId,
  })
  assert.equal(sentPrints(), 1)
})

const LISTED = {
  id: 'SimSerial',
  product_name: 'Form 4',
  status: 'Synthetic',
  is_connected: true,
  connection_type: 'USB',
  firmware_version: 'synthetic',
}
const FAMILY_FIELDS = {
  is_remote_print_enabled: false,
  estimated_print_time_remaining_ms: 0,
  tank_id: '',
  tank_material_code: '',
  cartridge_data: {},
  ready_to_print_now: true,
}
for (const [name, device] of [
  ['the generic shape', LISTED],
  [
    'a Form 3 field on a Form 4',
    { ...LISTED, ...FAMILY_FIELDS, form_auto_status: 'Synthetic' },
  ],
  [
    'a Form 3 without its Form Auto field',
    { ...LISTED, ...FAMILY_FIELDS, product_name: 'Form 3+' },
  ],
] as const) {
  test(`status rejects ${name}`, async (t) => {
    const server = createServer((_req, res) => {
      res.end(JSON.stringify({ count: 1, devices: [device] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const adapter = connectFormlabsOperations({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      deviceId: 'SimSerial',
    })
    await assert.rejects(adapter.status(), { reason: 'schema-mismatch' })
  })
}

test('undocumented operations are refused with a reason and source', async (t) => {
  const { sim, adapter, state } = await setup(t)
  await adapter.start(JOB)
  await adapter.upload({ ...JOB, jobName: 'Queued' })
  const before = state()
  const count = sim.requests.length
  for (const { model } of MODELS)
    for (const operation of [
      'job-list',
      'start-queued-job',
      'cancel',
      'pause',
      'resume',
      'discover',
      'upload-firmware',
    ] as const) {
      const result = adapter.refuse(model, operation)
      assert.equal(result.reason, 'unsupported-operation')
      assert.ok(result.detail)
      assert.match(result.source!, /^https:\/\/developer\.formlabs\.com\//)
    }
  assert.deepEqual(state(), before)
  assert.equal(sim.requests.length, count)
})

test('models without a verified schema support nothing', () => {
  for (const model of [
    'Form Studio 1',
    'Form 2',
    'Form 1+',
    'Fuse 1+',
    'Form 4B',
    'Form 4BL',
    'Form 3B+',
  ])
    for (const operation of ['status', 'upload', 'start', 'cancel']) {
      const support = formlabsOperationSupport(model, operation)
      assert.equal(!support.supported && support.reason, 'unsupported-model')
    }
  assert.equal(formlabsOperationSupport('Form 4', 'toString').supported, false)
})
