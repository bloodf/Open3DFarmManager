// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  applyDetailQuery,
  backfillHistory,
  downloadTimelapse,
  emptyDetailQueries,
  type DetailQueryState,
} from '../../apps/farm/app/utils/detail-query-view.ts'
import {
  DETAIL_QUERY_TIMEOUT_MS,
  MAX_DETAIL_QUERIES_IN_FLIGHT,
  createDetailQueries,
  queryKindsFor,
  type DetailQueryResponse,
} from '../../apps/farm/app/utils/webrtc/detail-queries.ts'
import {
  HISTORY_WINDOW_MS,
  detailTabs,
  type HeaterHistory,
} from '../../apps/farm/app/utils/printer-detail-view.ts'
import {
  createBambuDetailState,
  answerBambuDetailQuery,
  createBambuSdCard,
} from '../../packages/connector/src/bambu/printer-detail.ts'
import type { PauseCapabilityHandle } from '../../packages/connector/src/auth/pause-capability.ts'
import {
  MoonrakerRpcError,
  createMoonrakerDetailStream,
} from '../../packages/connector/src/moonraker/detail-stream.ts'
import { createFileList } from '../../packages/connector/src/runtime/file-list.ts'
import { createPrinterDetailSession } from '../../packages/connector/src/runtime/printer-detail-session.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import {
  FileListRequest,
  FileListResponse,
  MAX_TIMELAPSE_BYTES,
} from '../../packages/farm-protocol/src/file-list.ts'
import {
  assemblePrinterDetailFrames,
  decodePrinterDetailFrame,
  PrinterDetailStreamQueryResponse,
  type PrinterDetailStreamUpdate,
} from '../../packages/farm-protocol/src/printer-detail.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import type { z } from 'zod'

const KEY = 'printer-a'
const limits = {
  maxMessageBytes: 1_048_576,
  connectTimeoutMs: 1500,
  requestTimeoutMs: 1500,
  staleAfterMs: 5000,
  reconnectMinMs: 40,
  reconnectMaxMs: 160,
}
const dashboard = '../printer-detail/PrinterDetailDashboard.vue'
type Update = z.infer<typeof PrinterDetailStreamUpdate>

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(read: () => T | undefined | false, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > end) throw new Error('Timed out')
    await sleep(10)
  }
}

/** What the browser peer does: ask on each update, fold each answer. */
function connect(
  source: Parameters<typeof createPrinterDetailSession>[0] extends (
    key: string,
  ) => infer S
    ? S
    : never,
  advertised: readonly Update['capabilities'][number][] = [],
) {
  let state: DetailQueryState = emptyDetailQueries
  let history: HeaterHistory = {}
  const requests: string[] = []
  const answers: DetailQueryResponse[] = []
  let update: Update | undefined
  let chunks: string[] = []
  const detail = createPrinterDetailSession(
    (key) => (key === KEY ? source : undefined),
    (key) => key === KEY,
    (batch) => {
      for (const wire of batch) {
        let frame = decodePrinterDetailFrame(wire)
        if (frame.t === 'detail.chunk') {
          chunks.push(wire)
          if (chunks.length !== frame.total) continue
          frame = assemblePrinterDetailFrames(chunks)
          chunks = []
        }
        if (frame.t === 'detail.update') {
          update = frame
          queries.update([...frame.capabilities, ...advertised])
        } else if (frame.t === 'query.response') queries.receive(frame)
      }
    },
  )
  const queries = createDetailQueries({
    printerKey: KEY,
    send: (wire) => {
      requests.push(JSON.parse(wire).kind)
      detail.receive(wire)
    },
    onResponse(frame) {
      answers.push(frame)
      state = applyDetailQuery(state, frame)
      history = backfillHistory(history, frame, Date.now(), Date.now())
    },
  })
  cleanups.push(() => detail.close())
  detail.receive(
    JSON.stringify({ v: 1, t: 'detail.subscribe', printerKey: KEY }),
  )
  return {
    requests,
    answers,
    state: () => state,
    history: () => history,
    update: () => update,
  }
}

const handle = (
  controls: Parameters<typeof actionsForControlRole>[1],
  role: 'owner' | 'viewer' = 'owner',
) =>
  ({
    get current() {
      return {
        role,
        printer_key: KEY,
        actions: actionsForControlRole(role, controls),
      }
    },
  }) as unknown as PauseCapabilityHandle

function fileSession(
  target: Parameters<typeof createFileList>[0]['targetFor'],
  controls: Parameters<typeof actionsForControlRole>[1] = ['timelapse'],
  tamper?: (raw: string) => string,
) {
  const reply = vi.fn<(wire: string) => void>()
  const admitted = handle(controls)
  const files = createFileList({
    admittedHandle: () => admitted,
    send: reply,
    targetFor: target,
  })
  cleanups.push(() => files.close())
  return {
    reply,
    async listFiles(
      printerKey: string,
      directory?: string,
      download?: string,
      extra?: Record<string, unknown>,
    ) {
      const request = {
        type: 'files.list',
        printer_key: printerKey,
        request_id: randomUUID(),
        ...(directory === undefined ? {} : { directory }),
        ...(download === undefined ? {} : { download }),
        ...extra,
      }
      FileListRequest.parse(request)
      expect(files.receive(JSON.stringify(request))).toBe(true)
      await files.settled()
      const wire = reply.mock.lastCall![0]
      return FileListResponse.parse(JSON.parse(tamper ? tamper(wire) : wire))
    },
  }
}

let mock: MoonrakerMockInstance | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
})
const video: Buffer = Buffer.from(
  Array.from({ length: 40_000 }, (_, index) => (index * 7) % 251),
)
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function moonraker() {
  const now = Date.now() / 1000
  mock = await startMoonrakerMock({
    temperatureStoreLength: 30,
    files: [
      { path: 'fila-1.gcode', content: 'G1 X1\n' },
      { path: 'fila-2.gcode', content: 'G1 X2\n' },
    ],
    history: [
      {
        filename: 'peca-a.gcode',
        status: 'completed',
        start_time: now - 7200,
        end_time: now - 3600,
        print_duration: 3500,
        filament_used: 1500,
      },
      {
        filename: 'peca-b.gcode',
        status: 'cancelled',
        start_time: now - 1800,
        end_time: now - 900,
        print_duration: 800,
        filament_used: 300,
      },
    ],
    timelapseFiles: [
      { path: 'timelapse_peca-a.mp4', content: video },
      { path: 'timelapse_peca-b.mp4', content: Buffer.from('small') },
    ],
  })
  await fetch(`${mock.origin}/server/job_queue/job`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filenames: ['fila-1.gcode', 'fila-2.gcode'] }),
  })
  const stream = createMoonrakerDetailStream({
    printerKey: KEY,
    origin: mock.origin,
    limits,
  })
  return { origin: mock.origin, stream }
}

describe('query scheduling', () => {
  const frames: unknown[] = []
  const make = (clock: { now: number }) =>
    createDetailQueries({
      printerKey: KEY,
      send: (wire) => frames.push(JSON.parse(wire)),
      onResponse: () => {},
      clock: () => clock.now,
    })
  const answer = (id: string, kind: string, extra: object = {}) =>
    ({
      v: 1,
      t: 'query.response',
      printerKey: KEY,
      requestId: id,
      kind,
      ...extra,
    }) as DetailQueryResponse

  it('asks only for the areas the printer advertises', () => {
    expect(queryKindsFor(['heaters'])).toEqual(['temperature-store'])
    expect(queryKindsFor(['job'])).toEqual(['history', 'totals'])
    expect(queryKindsFor(['job-queue', 'timelapse'])).toEqual([
      'job-queue',
      'timelapse',
    ])
    expect(queryKindsFor(['console', 'files'])).toEqual([])
  })

  it('keeps inside the Connector bound of in-flight queries and refreshes on a schedule', () => {
    frames.length = 0
    const clock = { now: 0 }
    const queries = make(clock)
    queries.update(['heaters', 'job-queue', 'job', 'timelapse'])
    expect(frames).toHaveLength(MAX_DETAIL_QUERIES_IN_FLIGHT)
    const [first, second] = frames as { requestId: string; kind: string }[]
    expect(
      queries.receive(answer(first!.requestId, first!.kind, { data: [] })),
    ).toBe(true)
    // A stranger's answer never matches.
    expect(queries.receive(answer('other', 'history', { data: [] }))).toBe(
      false,
    )
    queries.update(['heaters', 'job-queue', 'job', 'timelapse'])
    expect(frames).toHaveLength(MAX_DETAIL_QUERIES_IN_FLIGHT + 1)
    expect(second).toBeDefined()
  })

  it('does not repeat the temperature backfill, retries a silent query and never retries unsupported', () => {
    frames.length = 0
    const clock = { now: 0 }
    const queries = make(clock)
    queries.update(['heaters'])
    const first = frames[0] as { requestId: string }
    queries.receive(answer(first.requestId, 'temperature-store', { data: [] }))
    clock.now = 3_600_000
    queries.update(['heaters'])
    expect(frames).toHaveLength(1)

    frames.length = 0
    queries.update(['job-queue'])
    expect(frames).toHaveLength(1)
    clock.now += 1000
    queries.update(['job-queue'])
    expect(frames).toHaveLength(1)
    clock.now += DETAIL_QUERY_TIMEOUT_MS
    queries.update(['job-queue'])
    expect(frames).toHaveLength(2)

    frames.length = 0
    queries.update(['timelapse'])
    const asked = frames[0] as { requestId: string }
    queries.receive(
      answer(asked.requestId, 'timelapse', { error: 'unsupported' }),
    )
    clock.now += 3_600_000
    queries.update(['timelapse'])
    expect(frames).toHaveLength(1)
  })
})

describe('Moonraker detail queries through the Connector session', () => {
  it('backfills the graph, lists the queue, history, totals and timelapse files', async () => {
    const { stream } = await moonraker()
    const chain = connect(stream, ['job-queue', 'timelapse'])
    const state = await until(() => {
      const current = chain.state()
      return (
        current.queue &&
        current.history &&
        current.totals &&
        current.timelapse &&
        current
      )
    })
    expect(chain.requests.sort()).toEqual(
      [
        'history',
        'job-queue',
        'temperature-store',
        'timelapse',
        'totals',
      ].sort(),
    )
    expect(state.queue?.jobs.map(({ file }) => file)).toEqual([
      'fila-1.gcode',
      'fila-2.gcode',
    ])
    expect(state.history?.map(({ file }) => file).sort()).toEqual([
      'peca-a.gcode',
      'peca-b.gcode',
    ])
    expect(state.totals).toMatchObject({ jobs: 2 })
    expect(state.timelapse?.files).toEqual([
      'timelapse_peca-a.mp4',
      'timelapse_peca-b.mp4',
    ])
    const history = chain.history()
    expect(Object.keys(history)).toContain('extruder')
    const samples = history.extruder!
    expect(samples.length).toBeGreaterThan(1)
    const now = Date.now()
    for (const { time } of samples) {
      expect(time).toBeLessThanOrEqual(now)
      expect(time).toBeGreaterThan(now - HISTORY_WINDOW_MS)
    }
  })

  it('shows the Fila, Timelapse and Histórico tabs and their data in the mounted dashboard', async () => {
    const { stream } = await moonraker()
    const chain = connect(stream, ['job-queue', 'timelapse'])
    const state = await until(() => {
      const current = chain.state()
      return current.queue && current.history && current.timelapse && current
    })
    await until(() => chain.state().totals)
    const live = chain.state()
    const capabilities = ['heaters', 'job-queue', 'timelapse', 'job'] as const
    expect(
      detailTabs(capabilities).available.map(({ label }) => label),
    ).toEqual(['Painel', 'Fila', 'Timelapse', 'Histórico'])
    const html = await renderFarmComponent(dashboard, {
      name: 'Voron',
      stateLabel: 'Ocioso',
      stateTone: 'idle',
      connectorLabel: 'conexão direta ativa',
      live: true,
      capabilities,
      heaters: [{ name: 'extruder', temperature: 200, maxTemp: 300 }],
      history: chain.history(),
      canCommand: true,
      canEmergencyStop: true,
      queue: {
        advertised: true,
        state: live.queue?.state,
        jobs: live.queue?.jobs,
        canCommand: true,
      },
      timelapse: {
        advertised: true,
        files: live.timelapse?.files,
        rendering: live.timelapse?.rendering,
        canCommand: true,
        canTransfer: true,
      },
      jobHistory: {
        advertised: true,
        jobs: state.history ?? [],
        totals: live.totals ?? null,
        openfarmJobs: [],
      },
    })
    for (const text of [
      'Fila',
      'Histórico',
      'Timelapse',
      'fila-1.gcode',
      'timelapse_peca-a.mp4',
      'peca-a.gcode',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('disabled=""><!--[-->Reproduzir')
  })

  it('shows a missing queue component as a failed kind, not as stale data', async () => {
    mock = await startMoonrakerMock({ timelapse: false })
    const real = createMoonrakerDetailStream({
      printerKey: KEY,
      origin: mock.origin,
      limits,
    })
    // Moonraker without the queue component answers "method not found".
    const stream = {
      ...real,
      subscribe: real.subscribe,
      request: (method: string, params?: Record<string, unknown>) =>
        method === 'server.job_queue.status'
          ? Promise.reject(new MoonrakerRpcError('Method not found', -32601))
          : real.request(method, params),
    }
    const chain = connect(stream, ['job-queue', 'timelapse'])
    await until(() => chain.answers.length >= 2)
    const errors = chain.state().errors
    expect(errors['job-queue']).toBe('unsupported')
    expect(errors.timelapse).toBeDefined()
    expect(chain.state().queue).toBeUndefined()
  })
})

describe('Bambu detail queries through the Connector session', () => {
  it('lists SD card timelapse files and does not ask for areas it lacks', async () => {
    const sim = await startBambuSimulator({ initialState: 'IDLE' })
    cleanups.push(() => sim.close())
    sim.uploadTimelapse('print-1.mp4', video)
    sim.uploadTimelapse('print-1.jpg', Buffer.from('thumb'))
    const card = createBambuSdCard({
      host: sim.host,
      port: sim.ftpsPort,
      serial: 'SYNTHETIC',
      accessCode: 'secret',
      trust: { caPem: sim.syntheticTrust },
    })
    const frame = createBambuDetailState('printer-1').ingest(
      JSON.stringify({
        print: { ipcam: { timelapse: 'enable' }, gcode_state: 'IDLE' },
      }),
    )
    const chain = connect({
      subscribe(listener) {
        listener({ ...(frame as object), printerKey: KEY })
        return () => {}
      },
      query: (kind, signal) =>
        answerBambuDetailQuery(
          kind,
          card,
          { ipcam: { timelapse: 'enable' } },
          signal,
        ),
    })
    const state = await until(() => chain.state().timelapse && chain.state())
    expect(state.timelapse?.files).toEqual([
      'timelapse/print-1.jpg',
      'timelapse/print-1.mp4',
    ])
    await until(() => chain.answers.length >= 2)
    expect(chain.requests.sort()).toEqual(['temperature-store', 'timelapse'])
    expect(chain.state().errors['temperature-store']).toBe('unsupported')
    expect(
      detailTabs(chain.update()!.capabilities).available.map((t) => t.id),
    ).toContain('timelapse')
  })
})

describe('timelapse transfer over the file-transfer channel', () => {
  it('downloads a Moonraker timelapse in chunks and checks size and digest', async () => {
    const { origin } = await moonraker()
    const session = fileSession(() => ({
      backend: 'moonraker',
      client: { request: async () => Promise.reject(Error('unused')) },
      thumbnailSource: { origin, limits },
    }))
    const bytes = await downloadTimelapse(
      session,
      KEY,
      'timelapse_peca-a.mp4',
      AbortSignal.timeout(5000),
    )
    expect(Buffer.from(bytes).equals(video)).toBe(true)
    // 40 000 bytes arrive in 16 KiB chunks.
    expect(session.reply).toHaveBeenCalledTimes(3)
    const small = await downloadTimelapse(
      session,
      KEY,
      'timelapse_peca-b.mp4',
      AbortSignal.timeout(5000),
    )
    expect(Buffer.from(small).toString()).toBe('small')
  })

  it('downloads a Bambu timelapse over FTPS', async () => {
    const sim = await startBambuSimulator({ initialState: 'IDLE' })
    cleanups.push(() => sim.close())
    sim.uploadTimelapse('print-1.mp4', video)
    const session = fileSession(() => ({
      backend: 'bambu',
      host: sim.host,
      port: sim.ftpsPort,
      serial: 'SYNTHETIC',
      accessCode: 'secret',
      trust: { caPem: sim.syntheticTrust },
    }))
    const bytes = await downloadTimelapse(
      session,
      KEY,
      'timelapse/print-1.mp4',
      AbortSignal.timeout(8000),
    )
    expect(sha(bytes)).toBe(sha(video))
  })

  it('refuses an unauthorized role, a missing file and a tampered chunk', async () => {
    const { origin } = await moonraker()
    const target = () =>
      ({
        backend: 'moonraker',
        client: { request: async () => Promise.reject(Error('unused')) },
        thumbnailSource: { origin, limits },
      }) as const
    const refused: string[] = []
    const viewerHandle = handle(['timelapse'], 'viewer')
    const viewerFiles = createFileList({
      admittedHandle: () => viewerHandle,
      send: (wire) => refused.push(wire),
      targetFor: target,
    })
    viewerFiles.receive(
      JSON.stringify({
        type: 'files.list',
        printer_key: KEY,
        request_id: randomUUID(),
        timelapse: true,
        download: 'timelapse_peca-b.mp4',
      }),
    )
    await viewerFiles.settled()
    expect(JSON.parse(refused[0]!)).toMatchObject({
      ok: false,
      reason: 'unauthorized',
    })
    viewerFiles.close()

    const session = fileSession(target)
    await expect(
      downloadTimelapse(
        session,
        KEY,
        'nao-existe.mp4',
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow('Timelapse indisponível')

    const tampered = fileSession(target, ['timelapse'], (wire) => {
      const parsed = JSON.parse(wire)
      if (parsed.download)
        parsed.download = Buffer.from('x'.repeat(5)).toString('base64')
      return JSON.stringify(parsed)
    })
    await expect(
      downloadTimelapse(
        tampered,
        KEY,
        'timelapse_peca-b.mp4',
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow('Timelapse alterado')
  })

  it('keeps the request schema bounded and gcodes downloads unchanged', () => {
    const base = { type: 'files.list', printer_key: KEY, request_id: 'r1' }
    expect(
      FileListRequest.safeParse({
        ...base,
        timelapse: true,
        download: 'a.mp4',
        offset: MAX_TIMELAPSE_BYTES,
      }).success,
    ).toBe(true)
    for (const bad of [
      { timelapse: true },
      { timelapse: true, download: 'a.mp4', directory: 'x' },
      { timelapse: true, download: 'a.mp4', offset: MAX_TIMELAPSE_BYTES + 1 },
      { timelapse: true, download: 'a.mp4', config: true },
      { download: 'a.gcode', offset: 1 },
      { config: true, configPath: 'printer.cfg', offset: 1024 * 1024 + 1 },
    ])
      expect(FileListRequest.safeParse({ ...base, ...bad }).success).toBe(false)
    expect(
      FileListRequest.safeParse({ ...base, download: 'a.gcode' }).success,
    ).toBe(true)
    expect(
      PrinterDetailStreamQueryResponse.safeParse({
        v: 1,
        t: 'query.response',
        printerKey: KEY,
        requestId: 'x',
        kind: 'timelapse',
        data: { enabled: true, rendering: false, files: [] },
      }).success,
    ).toBe(true)
  })
})

describe('the page wires the queries and the transfer', () => {
  it('feeds the queue, history and timelapse panels and handles the transfer', async () => {
    const page = await readFile(
      'apps/farm/app/pages/impressoras/[printerKey].vue',
      'utf8',
    )
    for (const needle of [
      'onQuery(frame)',
      'advertised: () =>',
      ':job-history="jobHistory"',
      '@timelapse-transfer="timelapseTransfer"',
      'downloadTimelapse(',
      '/api/job-history',
      "'job'",
    ])
      expect(page).toContain(needle)
    const peer = await readFile(
      'apps/farm/app/utils/webrtc/readonly-peer.ts',
      'utf8',
    )
    expect(peer).toContain('createDetailQueries(')
    expect(peer).toContain('onQuery')
  })
})
