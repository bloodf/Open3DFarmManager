// Spec-derived simulator tests of the resin history (Cmd 320/321) and video
// stream (Cmd 386). The video write goes through the shipped signed command
// dispatcher and journal; the ingest helper is replaced by a stand-in source
// (tests/journey/sdcp-control.spec.ts runs the real one). No printer is used.
import assert from 'node:assert/strict'
import test from 'node:test'
import { startSdcpSimulator } from '../../packages/sim-tools/src/sdcp-simulator.ts'
import { DriverRefusalError } from '../../packages/connector/src/control/driver-refusal.ts'
import {
  provisionSdcpPrinter,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { createSdcpCameraOpener } from '../../packages/connector/src/sdcp/camera.ts'
import {
  buildSdcpHistoryCommand,
  buildSdcpVideoCommand,
} from '../../packages/connector/src/sdcp/commands.ts'
import { answerSdcpDetailQuery } from '../../packages/connector/src/sdcp/detail.ts'
import { decodeSdcpHistoryTask } from '../../packages/connector/src/sdcp/history.ts'
import {
  SDCP_QUALIFIED_VIDEO,
  type SdcpQualification,
} from '../../packages/connector/src/sdcp/models.ts'
import {
  createSdcpVideo,
  SDCP_CAMERA_DEVICE,
  sdcpVideoDestination,
  type SdcpVideo,
} from '../../packages/connector/src/sdcp/video.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const model = 'Saturn 4 Ultra'
const board = 'fixture01'
const qualified = [{ model, firmwareVersion: 'V1.0.0' }]
const VIDEO = 'rtsp://127.0.0.1:8554/video'
const camera = { mainboardId: board, model }
const video = (list: readonly SdcpQualification[] = qualified) =>
  createSdcpVideo({ boards: [board], qualified: list })

async function setup(t: test.TestContext, videoUrl: string | undefined) {
  const sim = await startSdcpSimulator()
  t.after(() => sim.close())
  const machine = sim.simulate({
    family: 'resin',
    ...(videoUrl ? { videoUrl } : {}),
  })
  const source = {
    host: '127.0.0.1',
    mainboardId: board,
    model,
    discoveryPort: sim.discoveryPort,
    websocketPort: sim.websocketPort,
  }
  const commands = () =>
    (sim.requests as { Data: { Cmd: number; Data: unknown } }[])
      .map(({ Data }) => [Data.Cmd, Data.Data] as const)
      .filter(([cmd]) => cmd !== 0)
  return { sim, machine, source, commands }
}
type Setup = Awaited<ReturnType<typeof setup>>

/** One signed `power` command through the shipped dispatcher and journal. */
async function signedPower(
  t: test.TestContext,
  { source }: Setup,
  state: SdcpVideo,
  on: boolean,
  options: { role?: 'owner' | 'operator'; device?: string } = {},
) {
  const authority = await createV2Authority(await nodeSigner())
  const binding = provisionSdcpPrinter(
    {
      assignment_id: authority.ids.assignment_id,
      farm_id: authority.ids.farm_id,
      agent_id: authority.ids.agent_id,
      printer_key: authority.printerKey,
    },
    { printerKey: authority.printerKey, ...source },
  )
  let outer: PrinterBinding
  let advertised: readonly string[] = []
  const world = await openV2Dispatch(authority, {
    capability: { actions: ['power'], role: options.role ?? 'owner' },
    loopback: {
      origin: 'http://127.0.0.1:7125',
      driver({ clock, observe }) {
        const routes = createPauseDriverRouter({
          allowedOrigins: [],
          limits: {} as never,
          clock,
          sdcpVideo: state,
          observe: (_inner, observation) => observe(outer, observation),
        })
        return {
          detect: async () => {
            advertised = await routes.detect(binding)
          },
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
  const result = await world.dispatch(
    await authority.sign(
      {
        purpose: 'printer-control',
        action: 'power',
        args: { device: options.device ?? SDCP_CAMERA_DEVICE, on },
      },
      world.now(),
    ),
  )
  return { result, advertised }
}

function fakeStream() {
  let end = () => {}
  const closed = new Promise<void>((resolve) => {
    end = resolve
  })
  const opened: unknown[] = []
  const openSource = (async (options: {
    sourceHandle: string
    resolveLocal(handle: string): unknown
  }) => {
    opened.push(options.resolveLocal(options.sourceHandle))
    return { closed }
  }) as never
  return { opened, openSource, end: () => end() }
}

const media = (address = '127.0.0.1') => ({
  source: { ...camera, address },
  executable: { path: '/unused', sha256: '0'.repeat(64) },
  signal: new AbortController().signal,
  expiresAtMonoMs: performance.now() + 20_000,
  isCurrent: () => true,
})

test('the shipped video list is empty: no command and no Cmd 386', async (t) => {
  const printer = await setup(t, VIDEO)
  assert.deepEqual(SDCP_QUALIFIED_VIDEO, [])
  const state = createSdcpVideo({ boards: [board] })
  assert.equal(state.offered(camera), false)
  // Another firmware than the listed one is not offered either.
  const other = video([{ model, firmwareVersion: 'V9.9.9' }])
  for (const unqualified of [state, other]) {
    const sent = await signedPower(t, printer, unqualified, true)
    assert.ok(!sent.advertised.includes('power'))
    assert.equal(sent.result.kind, 'rejected')
    assert.equal(
      (sent.result as { reason: string }).reason,
      'unsupported-action',
    )
  }
  assert.deepEqual(printer.commands(), [])
  assert.equal(printer.machine.videoStreams, 0)
})

test('a signed power command enables and disables the stream once', async (t) => {
  const printer = await setup(t, VIDEO)
  const state = video()
  const stream = fakeStream()
  const open = createSdcpCameraOpener({
    video: state,
    openSource: stream.openSource,
    helperAvailable: () => true,
  })
  // Off: the camera path writes nothing and has nothing to open.
  await assert.rejects(open(media()), DriverRefusalError)
  assert.deepEqual(printer.commands(), [])

  const on = await signedPower(t, printer, state, true)
  assert.ok(on.advertised.includes('power'))
  // Sent, but the printer reports no stream state: never claimed as applied.
  assert.equal(on.result.kind, 'outcome-unknown', JSON.stringify(on.result))
  assert.equal(state.status(board), 'on')
  assert.equal(printer.machine.videoStreams, 1)

  // A stream address other than the configured camera's is not opened.
  await assert.rejects(open(media('127.0.0.2')), DriverRefusalError)
  await open(media())
  assert.deepEqual(stream.opened, [
    { address: '127.0.0.1', port: 8554, path: '/video' },
  ])
  await assert.rejects(open(media()), DriverRefusalError)
  stream.end()
  // Ending the viewer leaves the printer's stream alone.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(printer.machine.videoStreams, 1)

  const off = await signedPower(t, printer, state, false)
  assert.equal(off.result.kind, 'outcome-unknown')
  assert.equal(state.status(board), 'off')
  assert.equal(state.destination(board), undefined)
  assert.equal(printer.machine.videoStreams, 0)
  assert.deepEqual(printer.commands(), [
    [386, { Enable: 1 }],
    [386, { Enable: 0 }],
  ])
})

test('role and device are checked before anything is sent', async (t) => {
  const printer = await setup(t, VIDEO)
  const operator = await signedPower(t, printer, video(), true, {
    role: 'operator',
  }).catch((error: Error) => error)
  // `power` is owner or admin only: an operator capability is not admitted.
  assert.ok(operator instanceof Error)
  const device = await signedPower(t, printer, video(), true, {
    device: 'printer',
  })
  assert.equal(device.result.kind, 'not-sent')
  assert.equal((device.result as { reason: string }).reason, 'invalid-command')
  assert.deepEqual(printer.commands(), [])
})

test('a refused or foreign video answer is not retried or followed', async (t) => {
  const none = await setup(t, undefined)
  const missing = video()
  const refused = await signedPower(t, none, missing, true)
  assert.equal(refused.result.kind, 'outcome-unknown')
  assert.equal(missing.status(board), 'off')
  assert.deepEqual(none.commands(), [[386, { Enable: 1 }]])

  const foreign = await setup(t, 'rtsp://10.0.0.9/video')
  const elsewhere = video()
  await signedPower(t, foreign, elsewhere, true)
  // Open on the printer, unusable here: only a signed command turns it off.
  assert.equal(elsewhere.status(board), 'on')
  assert.equal(elsewhere.destination(board), undefined)
  assert.deepEqual(foreign.commands(), [[386, { Enable: 1 }]])

  // The printer's stream limit means one is open, so it can be turned off.
  const full = await setup(t, VIDEO)
  full.machine.videoStreams = 1
  const limit = video()
  await signedPower(t, full, limit, true)
  assert.equal(limit.status(board), 'on')
})

test('nothing is opened without the ingest helper', async () => {
  const open = createSdcpCameraOpener({
    video: video(),
    helperAvailable: () => false,
  })
  await assert.rejects(open(media()), { code: 'HELPER_EXECUTABLE' })
})

test('only an RTSP address on the printer itself is accepted', () => {
  assert.deepEqual(
    sdcpVideoDestination('rtsp://192.168.1.4/video', '192.168.1.4'),
    { address: '192.168.1.4', port: 554, path: '/video' },
  )
  for (const value of [
    'http://192.168.1.4/video',
    'rtsp://192.168.1.5/video',
    'rtsp://user:pass@192.168.1.4/video',
    'rtsp://192.168.1.4/video?token=1',
    'rtsp://192.168.1.4',
    '192.168.1.4:554/video',
    42,
  ])
    assert.throws(() => sdcpVideoDestination(value, '192.168.1.4'))
})

test('history is read by id with its outcomes', async (t) => {
  const { source, machine, commands } = await setup(t, undefined)
  const task = (n: number, TaskStatus: number) => ({
    TaskId: `task-${n}`,
    TaskName: `/local/part-${n}.goo`,
    BeginTime: 1_700_000_000 + n * 100,
    EndTime: 1_700_000_060 + n * 100,
    TaskStatus,
  })
  // Seventeen tasks need two detail requests; status 0 names no outcome.
  machine.history.push(
    ...Array.from({ length: 17 }, (_, n) => task(n, [1, 2, 3, 0][n % 4]!)),
  )
  const reply = await answerSdcpDetailQuery(
    source,
    'history',
    new AbortController().signal,
  )
  assert.ok('data' in reply)
  assert.equal(reply.data.length, 13)
  assert.deepEqual(reply.data[0], {
    id: 'task-16',
    file: 'part-16.goo',
    state: 'completed',
    startedAtMs: 1_700_001_600_000,
    durationSeconds: 60,
  })
  assert.deepEqual(
    commands().map(([cmd]) => cmd),
    [320, 321, 321],
  )
  assert.deepEqual(
    await answerSdcpDetailQuery(source, 'totals', AbortSignal.timeout(1000)),
    { error: 'unsupported' },
  )
  assert.equal(decodeSdcpHistoryTask({ ...task(1, 1), EndTime: 1 }), undefined)
})

test('the Carbon is sent neither history nor video commands', () => {
  for (const build of [
    () => buildSdcpHistoryCommand('Centauri Carbon'),
    () => buildSdcpVideoCommand('Centauri Carbon', true),
  ])
    assert.throws(build, DriverRefusalError)
  assert.equal(
    createSdcpVideo({
      boards: [board],
      qualified: [{ model: 'Centauri Carbon', firmwareVersion: 'V1.1.46' }],
    }).offered({ mainboardId: board, model: 'Centauri Carbon' }),
    false,
  )
})
