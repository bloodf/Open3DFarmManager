import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseCollectorConfig } from '../../packages/connector/src/prusa/config.ts'
import {
  createPrusaConnectLocal,
  createPrusaLink,
} from '../../packages/connector/src/prusa/index.ts'
import {
  PRUSA_LINK_MODELS,
  prusaLinkBinding,
} from '../../packages/connector/src/prusa/models.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import {
  startPrusaLinkPrinterSimulator,
  startPrusaSimulator,
  type PrusaLinkSimulatorOptions,
} from '../../packages/sim-tools/src/prusa-simulator.ts'

// Expected wire values are written out here rather than read from the table
// under test. prusa3d/Prusa-Firmware-Buddy @
// b1043d68be188ad27ea72a14e160140e30e589f0,
// include/common/printer_model_data.hpp
const BUDDY = [
  ['Prusa CORE One', '7.1.0'],
  ['Prusa CORE One+', '7.1.0'],
  ['Prusa CORE One L', '8.1.0'],
  ['Prusa XL', '3.1.0'],
  ['Prusa MK4', '1.4.0'],
  ['Prusa MK4S', '1.4.1'],
  ['Prusa MK3.9', '1.3.9'],
  ['Prusa MK3.9S', '1.3.10'],
  ['Prusa MK3.5', '1.3.5'],
  ['Prusa MK3.5S', '1.3.6'],
  ['Prusa MINI', '2.1.0'],
  ['Prusa MINI+', '2.1.0'],
] as const
// prusa3d/Prusa-Link @ 58a0ab1703680c32d39c76684e906c8f2ea91464
const PI = [
  'Prusa MK2.5',
  'Prusa MK2.5S',
  'Prusa MK3',
  'Prusa MK3S',
  'Prusa MK3S+',
]

const KEY = 'sim-key'
const allow = { beforeSend: () => true }
const gcode = () => new TextEncoder().encode('G28\n')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X9sAAAAASUVORK5CYII=',
  'base64',
)

async function printer(
  t: TestContext,
  options: Partial<PrusaLinkSimulatorOptions> = {},
) {
  const sim = await startPrusaLinkPrinterSimulator({
    serial: 'SIM-PRUSA',
    apiKey: KEY,
    printerType: '1.4.0',
    ...options,
  })
  t.after(sim.close)
  const link = createPrusaLink(sim.endpoint, KEY)
  return {
    sim,
    link,
    state: async () => (await link.status()).printer.state,
    jobId: async () => Number((await link.status()).job?.id),
    // The adapter has no file or job read, so the test observes the printer's
    // own reports directly.
    async read(path: string) {
      const response = await fetch(new URL(path, sim.endpoint), {
        headers: { 'X-Api-Key': KEY },
      })
      return {
        status: response.status,
        body: response.status === 200 ? await response.json() : undefined,
      }
    },
  }
}

test('every catalog Prusa model has a binding or a stated refusal', () => {
  assert.deepEqual(
    PRUSA_LINK_MODELS.map((entry) => entry.model),
    [...BUDDY.map(([model]) => model), ...PI],
  )
  const input = {
    printerKey: 'bench',
    origin: 'http://127.0.0.1:9',
    apiKeyFile: '/nonexistent/prusa-key.json',
    serial: 'SIM-PRUSA',
  }
  for (const [model, printerType] of BUDDY)
    assert.deepEqual(prusaLinkBinding({ ...input, model }), {
      family: 'prusa-link',
      printerKey: 'bench',
      origin: input.origin,
      apiKeyFile: input.apiKeyFile,
      expect: { serial: 'SIM-PRUSA', printerType },
    })
  for (const model of PI)
    assert.throws(
      () => prusaLinkBinding({ ...input, model }),
      /refused .*no-wire-model-identity/,
    )
  assert.throws(
    () => prusaLinkBinding({ ...input, model: 'Prusa SL1' }),
    /Unknown PrusaLink model/,
  )
  for (const entry of PRUSA_LINK_MODELS)
    assert.equal(
      entry.camera,
      entry.host === 'buddy' ? 'no-route' : 'documented',
    )
})

for (const [model, printerType] of BUDDY)
  test(`${model}: each operation shows up in the reported state`, async (t) => {
    const { sim, link, state, jobId, read } = await printer(t, { printerType })
    const { version, info } = await link.discover()
    assert.equal(version.printer, printerType)
    assert.equal(info.serial, 'SIM-PRUSA')
    assert.equal(await state(), 'IDLE')
    const path = '/api/v1/files/usb/part.gcode'
    assert.equal((await read(path)).status, 404)

    await link.upload('usb', 'part.gcode', gcode(), allow)
    assert.equal((await read(path)).body.size, 4)
    // Print-After-Upload is never sent, so the upload starts nothing.
    assert.equal(await state(), 'IDLE')

    await link.start('usb', 'part.gcode', allow)
    assert.equal(await state(), 'PRINTING')
    assert.equal((await read('/api/v1/job')).body.file.name, 'part.gcode')
    const id = await jobId()

    await link.control(id, 'pause', allow)
    assert.equal(await state(), 'PAUSED')

    // Resuming still reports PAUSED: the 204 is not the outcome.
    await link.control(id, 'resume', allow)
    assert.equal(await state(), 'PAUSED')
    sim.settle()
    assert.equal(await state(), 'PRINTING')

    // Aborting still reports PRINTING.
    await link.control(id, 'cancel', allow)
    assert.equal(await state(), 'PRINTING')
    sim.settle()
    assert.equal(await state(), 'STOPPED')
    assert.equal((await link.status()).job, undefined)
    assert.equal((await read('/api/v1/job')).status, 204)

    await assert.rejects(link.camera(), { status: 404 })
  })

test('Buddy refusals leave the reported state and files unchanged', async (t) => {
  const { sim, link, state, jobId, read } = await printer(t)
  const stored = () => sim.storedFile('usb/part.gcode')?.toString()

  await assert.rejects(link.upload('local', 'part.gcode', gcode(), allow), {
    status: 403,
  })
  await assert.rejects(link.start('usb', 'part.gcode', allow), { status: 404 })
  await link.upload('usb', 'part.gcode', gcode(), allow)
  await assert.rejects(
    link.upload('usb', 'part.gcode', new Uint8Array([88]), allow),
    { status: 409 },
  )
  assert.equal(stored(), 'G28\n')

  const before = sim.requests.length
  await assert.rejects(
    link.start('usb', 'part.gcode', { beforeSend: () => false }),
    /denied/,
  )
  assert.equal(sim.requests.length, before)
  assert.equal(await state(), 'IDLE')

  await link.start('usb', 'part.gcode', allow)
  const id = await jobId()
  await assert.rejects(link.start('usb', 'part.gcode', allow), { status: 409 })
  await assert.rejects(link.control(id, 'resume', allow), { status: 409 })
  await assert.rejects(link.control(id + 1, 'pause', allow), { status: 404 })
  await assert.rejects(link.control(id + 1, 'cancel', allow), { status: 404 })
  assert.equal(await state(), 'PRINTING')
  assert.equal(await jobId(), id)

  sim.finishPrint()
  assert.equal(await state(), 'FINISHED')
  for (const action of ['pause', 'resume', 'cancel'] as const)
    await assert.rejects(link.control(id, action, allow), { status: 409 })
  assert.equal(await state(), 'FINISHED')

  sim.startLocalPrint('part.gcode')
  sim.failPrint()
  assert.equal(await state(), 'ERROR')
  await assert.rejects(link.start('usb', 'part.gcode', allow), { status: 409 })
  assert.equal(await state(), 'ERROR')

  await assert.rejects(createPrusaLink(sim.endpoint, 'wrong').status(), {
    status: 401,
  })
  assert.equal((await read('/api/v1/cameras/snap')).status, 404)
})

test('a lost acknowledgement stays uncertain and is not retried', async (t) => {
  const { sim, link, state, jobId } = await printer(t)
  await link.upload('usb', 'part.gcode', gcode(), allow)
  await link.start('usb', 'part.gcode', allow)
  const id = await jobId()
  const before = sim.requests.length
  sim.loseNextCommandReply()
  await assert.rejects(link.control(id, 'pause', allow), { code: 'ECONNRESET' })
  assert.deepEqual(
    sim.requests.slice(before).map((request) => request.method),
    ['PUT'],
  )
  assert.equal(await state(), 'PAUSED')
})

test('Pi PrusaLink applies adapter operations but offers no model identity', async (t) => {
  const { sim, link, state, jobId, read } = await printer(t, {
    host: 'pi-prusalink',
  })
  const { version } = await link.discover()
  assert.equal(version.printer, undefined)

  await assert.rejects(link.camera(), { status: 404 })
  sim.setCamera('empty')
  assert.equal(await link.camera(), null)
  sim.setCamera(png)
  assert.deepEqual(await link.camera(), {
    contentType: 'image/png',
    bytes: new Uint8Array(png),
  })

  await assert.rejects(link.upload('sdcard', 'part.gcode', gcode(), allow), {
    status: 409,
  })
  await link.upload('local', 'part.gcode', gcode(), allow)
  assert.equal(
    (await read('/api/v1/files/local/part.gcode')).body.size,
    gcode().byteLength,
  )
  assert.equal(await state(), 'IDLE')
  await link.start('local', 'part.gcode', allow)
  assert.equal(await state(), 'PRINTING')
  const id = await jobId()

  // Job commands are queued to the printer: nothing changes until it applies.
  for (const [action, was, becomes] of [
    ['pause', 'PRINTING', 'PAUSED'],
    ['resume', 'PAUSED', 'PRINTING'],
    ['cancel', 'PRINTING', 'STOPPED'],
  ] as const) {
    await link.control(id, action, allow)
    assert.equal(await state(), was)
    sim.settle()
    assert.equal(await state(), becomes)
  }
  await assert.rejects(createPrusaLink(sim.endpoint, 'wrong').status(), {
    status: 403,
  })
})

test('an unknown PrusaLink API major version is refused', async (t) => {
  const sim = await startPrusaSimulator((_req, res) => {
    res.end('{"api":"3.0.0"}')
  })
  t.after(sim.close)
  await assert.rejects(
    createPrusaLink(sim.endpoint, KEY).discover(),
    /Unsupported PrusaLink API version/,
  )
})

test('Connect Local reads report the simulated printer and its job history', async (t) => {
  const connectOptions = {
    token: 'sim-token',
    deviceId: 'printer-1',
    camera: 'bench',
  }
  const { sim, link, jobId } = await printer(t, { connect: connectOptions })
  const connect = createPrusaConnectLocal(sim.endpoint, 'sim-token')
  const deviceState = async () =>
    ((await connect.status('printer-1')) as { state?: unknown }).state
  assert.deepEqual(await deviceState(), { '/state': 'IDLE' })
  assert.deepEqual((await connect.history('printer-1')).items, [])

  await link.upload('usb', 'part.gcode', gcode(), allow)
  await link.start('usb', 'part.gcode', allow)
  assert.deepEqual(await deviceState(), { '/state': 'PRINTING' })
  assert.equal((await connect.discover()).items[0]?.id, 'printer-1')
  const id = await jobId()
  await link.control(id, 'cancel', allow)
  sim.settle()
  assert.deepEqual((await connect.history('printer-1')).items, [
    { device_id: 'printer-1', id: String(id), state: 'STOPPED' },
  ])

  await assert.rejects(connect.camera('bench'), { status: 404 })
  sim.setCamera(png)
  assert.equal((await connect.camera('bench'))?.contentType, 'image/png')
  await assert.rejects(
    createPrusaConnectLocal(sim.endpoint, 'wrong').discover(),
    { status: 403 },
  )
})

test(
  'the Connector collects every bindable model and refuses mismatched identity',
  { timeout: 60_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'prusa-models-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    // One printer per distinct wire identity, plus two that must be refused:
    // an MK4S behind an MK4 binding, and a Pi host that names no model.
    const distinct = [...new Map(BUDDY.map(([m, type]) => [type, m])).values()]
    const cases = [
      ...distinct.map((model) => ({
        key: model,
        model,
        host: 'buddy' as const,
        printerType: BUDDY.find(([m]) => m === model)![1] as string,
      })),
      {
        key: 'mismatch',
        model: 'Prusa MK4',
        host: 'buddy' as const,
        printerType: '1.4.1',
      },
      {
        key: 'pi',
        model: 'Prusa MK4',
        host: 'pi-prusalink' as const,
        printerType: '1.4.0',
      },
    ]
    const printers = await Promise.all(
      cases.map(async (entry) => {
        const { sim, link } = await printer(t, {
          host: entry.host,
          printerType: entry.printerType,
        })
        const apiKeyFile = join(directory, `${keyFor(entry.key)}.json`)
        writeFileSync(
          apiKeyFile,
          JSON.stringify({ origin: sim.endpoint, apiKey: KEY }),
          { mode: 0o600 },
        )
        return {
          ...entry,
          sim,
          link,
          binding: prusaLinkBinding({
            model: entry.model,
            printerKey: keyFor(entry.key),
            origin: sim.endpoint,
            apiKeyFile,
            serial: 'SIM-PRUSA',
          }),
        }
      }),
    )
    const config = parseCollectorConfig({
      version: 8,
      allowedOrigins: printers.map((value) => value.sim.endpoint),
      printers: [],
      drivers: printers.map((value) => value.binding),
    })

    const controller = new AbortController()
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const latest = new Map<string, { state: string; model: string }>()
    const unavailable = new Set<string>()
    const run = collectIntoQueue({
      config,
      queue,
      signal: controller.signal,
      onDiagnostic() {},
      onRawObservation({ printerKey, printer: observed }) {
        latest.set(printerKey, {
          state: observed.state,
          model: observed.identity?.model ?? '',
        })
      },
      onRawUnavailable({ printerKey }) {
        unavailable.add(printerKey)
      },
    })
    const accepted = printers.slice(0, distinct.length)
    async function until(check: () => boolean) {
      const deadline = Date.now() + 15_000
      while (!check()) {
        assert.ok(Date.now() < deadline, 'collector did not report in time')
        await delay(50)
      }
    }
    const allReport = (state: string) =>
      until(() =>
        accepted.every(
          (value) => latest.get(value.binding.printerKey)?.state === state,
        ),
      )
    try {
      await allReport('idle')
      for (const value of accepted)
        assert.equal(
          latest.get(value.binding.printerKey)?.model,
          value.printerType,
        )
      for (const value of accepted) {
        await value.link.upload('usb', 'part.gcode', gcode(), allow)
        await value.link.start('usb', 'part.gcode', allow)
      }
      await allReport('printing')
      for (const value of accepted) {
        const id = Number((await value.link.status()).job?.id)
        await value.link.control(id, 'pause', allow)
      }
      await allReport('paused')
      for (const value of accepted) value.sim.finishPrint()
      await allReport('idle')
      const refused = ['mismatch', 'pi'].map(keyFor)
      await until(() => refused.every((key) => unavailable.has(key)))
      for (const key of refused) assert.equal(latest.has(key), false)
      // Identity fails before any status read.
      for (const value of printers.slice(distinct.length))
        assert.equal(
          value.sim.requests.some(
            (request) => request.path === '/api/v1/status',
          ),
          false,
        )
    } finally {
      controller.abort()
      await run
      queue.close()
    }
  },
)

function keyFor(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
