import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { test, type TestContext } from 'node:test'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { listDetailWebcams } from '../../packages/connector/src/moonraker/control-webcams.ts'
import { createMoonrakerDetailStream } from '../../packages/connector/src/moonraker/detail-stream.ts'
import { parseWebcamsResult } from '../../packages/connector/src/moonraker/discovery-parse.ts'
import { discoverMoonraker } from '../../packages/connector/src/moonraker/discovery.ts'
import {
  parseMoonrakerServerInfo,
  parseMoonrakerSnapshot,
} from '../../packages/connector/src/moonraker/parse.ts'
import { createMoonrakerSnapshotSource } from '../../packages/connector/src/moonraker/snapshot.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import {
  declareSnapmakerU1Printers,
  mapSnapmakerU1Tools,
} from '../../packages/connector/src/moonraker/u1-tools.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockOptions,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  type ExtendedControlAction,
} from '../helpers/command-v2-dispatch.ts'
import {
  MOONRAKER_FIXTURES,
  moonrakerFixture,
  moonrakerFixtureText,
} from '../helpers/moonraker-fixture.ts'
import { serveWsTestServer } from '../unit/ws-serve.ts'

// Simulators and loopback servers only: no physical printer or camera is
// contacted. No fixture here was captured; each file cites its sources.
const limits = {
  maxMessageBytes: 65536,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 5000,
  reconnectMinMs: 10_000,
  reconnectMaxMs: 10_000,
}

/** Names read by the tests below; the last test compares it with the folder. */
const exercised = new Set<string>()
function load(name: string) {
  exercised.add(name)
  return moonrakerFixture(name)
}

async function until<T>(read: () => T | undefined, message: string) {
  const deadline = performance.now() + 5000
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    assert.ok(performance.now() < deadline, message)
    await delay(10)
  }
}

async function u1World(t: TestContext, options: MoonrakerMockOptions = {}) {
  const authority = await createV2Authority(await nodeSigner())
  const withdraw = declareSnapmakerU1Printers([
    { printerKey: authority.printerKey, model: 'Snapmaker U1' },
  ])
  t.after(withdraw)
  const remote = await startMoonrakerMock({ profile: 'u1', ...options })
  t.after(() => remote.close())
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions: ['gcode', 'set_tool_temperature'] },
    loopback: {
      origin: remote.origin,
      driver({ clock, observe }) {
        const router = createPauseDriverRouter({
          allowedOrigins: [remote.origin],
          limits,
          clock,
          observe,
          gcodeConsole: () => true,
        })
        return {
          ...router,
          closeAttempt(binding) {
            retired = router.closeAttempt(binding)
            return retired
          },
        }
      },
    },
  })
  t.after(() => session.close())
  async function run(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
  ) {
    retired = undefined
    const result = await session.dispatch(
      await authority.sign(
        { action, args, purpose: 'printer-control' },
        session.now(),
      ),
    )
    await retired
    return result
  }
  return { remote, run }
}

test('webcam fixture: only the same-host snapshot camera yields a usable URL', async (t) => {
  const { webcams } = load('webcams.jsonc').result
  const jpeg = readFileSync(
    new URL(
      '../../packages/sim-cams/fixtures/test-pattern.jpg',
      import.meta.url,
    ),
  )
  const requested: string[] = []
  const camera = createServer((request, response) => {
    requested.push(request.url!)
    response.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg)
  })
  camera.listen(0, '127.0.0.1')
  await once(camera, 'listening')
  t.after(() => {
    camera.close()
    camera.closeAllConnections()
  })
  const address = camera.address()
  assert.ok(address && typeof address !== 'string')
  const webcamOrigin = `http://127.0.0.1:${address.port}`
  const remote = await startMoonrakerMock({ profile: 'u1', webcams })
  t.after(() => remote.close())

  const discovered = await discoverMoonraker({
    origin: remote.origin,
    webcamOrigin,
    limits,
    signal: AbortSignal.timeout(10_000),
    client: { name: 'fixture', version: '1', url: 'https://example.invalid' },
  })
  const [snapshot, rtsp] = discovered.webcams
  assert.ok(snapshot && rtsp)
  assert.deepEqual(
    [snapshot.snapshotPath, snapshot.snapshotUrl, snapshot.rotation],
    ['/webcam/?action=snapshot', `${webcamOrigin}/webcam/?action=snapshot`, 90],
  )
  // A printer-reported RTSP address is listed by name and never becomes a
  // target: RTSP cameras come only from the Connector's local configuration.
  assert.deepEqual(
    [rtsp.streamPath, rtsp.streamUrl, rtsp.snapshotPath, rtsp.snapshotUrl],
    [null, null, null, null],
  )
  assert.throws(() =>
    createMoonrakerSnapshotSource({
      webcamOrigin,
      snapshotUrl: webcams[1].stream_url,
    }),
  )
  // Without a configured webcam origin nothing resolves.
  for (const cam of parseWebcamsResult({ webcams }, null))
    assert.deepEqual([cam.streamUrl, cam.snapshotUrl], [null, null])
  // The browser-facing list carries no address at all.
  const listed = await listDetailWebcams(async () => ({ webcams }))
  assert.deepEqual(
    listed.map((cam) => cam.name),
    ['synthetic-snapshot', 'synthetic-rtsp'],
  )
  assert.doesNotMatch(JSON.stringify(listed), /rtsp:|\?action=|127\.0\.0\.1/)

  const frame = await createMoonrakerSnapshotSource({
    webcamOrigin,
    snapshotUrl: snapshot.snapshotPath!,
  }).read(AbortSignal.timeout(5000))
  assert.deepEqual(frame, jpeg)
  assert.deepEqual(requested, ['/webcam/?action=snapshot'])
})

test('shutdown fixture: not ready, shown as an error and never as a live job', () => {
  const fixture = load('klippy-shutdown.jsonc')
  assert.deepEqual(
    parseMoonrakerServerInfo(JSON.stringify(fixture.server_info)),
    { connected: true, state: 'shutdown', ready: false },
  )
  const { printer } = parseMoonrakerSnapshot(JSON.stringify(fixture.snapshot), {
    printerKey: 'k1',
    observedAt: 1000,
  })
  assert.equal(printer.state, 'error')
  assert.equal(printer.lastJob, undefined)
})

test('shutdown fixture: the notification ends the live Moonraker source', async (t) => {
  const { notification } = load('klippy-shutdown.jsonc')
  let announce = () => {}
  const server = await serveWsTestServer({
    http: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    upgrade: () => true,
    onMessage(socket, wire) {
      const { id, method } = JSON.parse(wire)
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
      if (method === 'server.connection.identify')
        return reply({ connection_id: 1 })
      announce = () => socket.send(JSON.stringify(notification))
      reply({
        eventtime: 1,
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: 'printing' },
          virtual_sdcard: { progress: 0.25 },
        },
      })
    },
  })
  t.after(() => server.stop())
  const controller = new AbortController()
  let observed: number | undefined
  const reasons: string[] = []
  const subscription = createMoonrakerSubscription({
    assignment: {
      printerKey: 'k1',
      origin: `http://127.0.0.1:${server.port}`,
    },
    allowedOrigins: [`http://127.0.0.1:${server.port}`],
    limits,
    signal: controller.signal,
    onEvent(event) {
      if (event.kind === 'unavailable') reasons.push(event.reason)
    },
    onRawObservation() {
      observed = 1
    },
  })
  t.after(async () => {
    controller.abort()
    await subscription.done
  })
  await until(() => observed, 'No live observation')
  // The feed reports 'connecting' before it is live.
  const before = reasons.length
  announce()
  assert.equal(
    await until(() => reasons[before], 'Source stayed live'),
    'not-ready',
  )
})

test('shutdown fixture: signed U1 commands write nothing', async (t) => {
  const { snapshot } = load('klippy-shutdown.jsonc')
  const { remote, run } = await u1World(t)
  remote.control.setKlippyState('shutdown', {
    message: snapshot.result.status.webhooks.state_message,
  })
  for (const [action, args] of [
    ['gcode', { line: 'T1' }],
    ['gcode', { line: 'M105' }],
    ['set_tool_temperature', { tool: 1, target_c: 0 }],
  ] as const) {
    const result = await run(action, args)
    assert.ok(
      result.kind === 'not-sent' || result.kind === 'rejected',
      JSON.stringify(result),
    )
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
})

test('G-code error fixture: a refused tool change is unknown and not retried', async (t) => {
  const { error } = load('gcode-error.jsonc')
  const { remote, run } = await u1World(t)
  remote.control.faults.addFault({
    path: '/websocket',
    method: 'printer.gcode.script',
    fault: { type: 'refuse', ...error },
    count: 1,
  })
  const result = await run('gcode', { line: 'T1' })
  assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
  assert.equal(result.reason, 'rpc-unknown')
  assert.equal(remote.calls()['printer.gcode.script'], 1)
  assert.equal(remote.control.model().activeExtruder, 'extruder')
})

test('G-code error fixture: the "!!" report never confirms a query', async (t) => {
  const { notification } = load('gcode-error.jsonc')
  const report: string = notification.params[0]
  let respond = () => {}
  const { remote, run } = await u1World(t, {
    gcodeQueryReports: false,
    onMacroCall: () => respond(),
  })
  respond = () => remote.control.broadcastGcodeResponse(report)
  const result = await run('gcode', { line: 'M105' })
  assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
  assert.equal(result.reason, 'state-unconfirmed')
  assert.deepEqual(remote.control.gcodeScripts, ['M105'])
})

test('G-code error fixture: the "!!" report reaches the console stream', async (t) => {
  const { notification } = load('gcode-error.jsonc')
  const remote = await startMoonrakerMock({ profile: 'u1' })
  t.after(() => remote.close())
  const frames: { t: string; lines?: string[] }[] = []
  const stop = createMoonrakerDetailStream({
    printerKey: 'u1',
    origin: remote.origin,
    limits,
  }).subscribe((frame) => frames.push(frame as (typeof frames)[number]))
  t.after(stop)
  await until(
    () => frames.find((frame) => frame.t === 'detail.update'),
    'No detail update',
  )
  remote.control.broadcastGcodeResponse(notification.params[0])
  const forwarded = await until(
    () => frames.find((frame) => frame.t === 'detail.gcode_response'),
    'Error line not forwarded',
  )
  assert.deepEqual(forwarded.lines, notification.params)
})

test('status fixtures still parse on current main', () => {
  exercised.add('printing.json')
  const context = { printerKey: 'k1', observedAt: 1000 }
  const printing = parseMoonrakerSnapshot(
    moonrakerFixtureText('printing.json'),
    context,
  ).printer
  assert.deepEqual(
    [printing.state, printing.progress, printing.filename],
    ['printing', 0.25, 'synthetic-test.gcode'],
  )
  const generic = parseMoonrakerSnapshot(
    JSON.stringify(load('u1/generic-klipper.jsonc')),
    context,
  ).printer
  assert.deepEqual(
    [generic.state, generic.filename],
    ['printing', 'benchy.gcode'],
  )
  const full = load('u1/four-tools.jsonc')
  assert.equal(mapSnapmakerU1Tools(full.status, full.objects).activeTool, 'T2')
  const partial = load('u1/missing-fields.jsonc')
  const mapped = mapSnapmakerU1Tools(partial.status, partial.objects)
  assert.equal(mapped.activeTool, null)
  assert.equal(mapped.tools[3]?.reported, false)
})

test('no Moonraker fixture is left unexercised', () => {
  const folder = fileURLToPath(MOONRAKER_FIXTURES)
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
  assert.deepEqual(files.sort(), [...exercised].sort())
})
