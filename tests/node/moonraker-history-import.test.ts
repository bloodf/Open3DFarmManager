import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { serveWsTestServer, type WsTestSocket } from '../unit/ws-serve.ts'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createMoonrakerHistoryImport } from '../../packages/connector/src/moonraker/history-import.ts'
import {
  HISTORY_MAX_PAGES,
  HISTORY_PAGE_SIZE,
  createMoonrakerHistoryDedup,
  parseMoonrakerHistoryPage,
  readMoonrakerHistory,
} from '../../packages/connector/src/moonraker/history.ts'

const nowSeconds = () => Math.floor(Date.now() / 1000)
const job = (index: number, extra: Record<string, unknown> = {}) => ({
  job_id: String(index),
  filename: `part-${index}.gcode`,
  start_time: nowSeconds() - 7200 - index * 600,
  end_time: nowSeconds() - 3600 - index * 600,
  print_duration: 1000 + index,
  total_duration: 1100 + index,
  filament_used: 250.5,
  status: 'completed',
  ...extra,
})

test('maps Moonraker history entries and skips unfinished ones', () => {
  const page = parseMoonrakerHistoryPage({
    count: 5,
    jobs: [
      job(1, { filename: 'a\u0000b.gcode' }),
      job(2, { status: 'cancelled' }),
      job(3, { status: 'klippy_shutdown' }),
      job(4, { status: 'in_progress', end_time: null }),
      job(5, { status: 'completed', end_time: -1 }),
      'garbage',
    ],
  })
  assert.equal(page.entries, 6)
  assert.deepEqual(
    page.jobs.map((value) => [value.filename, value.outcome]),
    [
      ['ab.gcode', 'completed'],
      ['part-2.gcode', 'cancelled'],
      ['part-3.gcode', 'failed'],
    ],
  )
  const [first] = page.jobs
  assert.equal(first?.filamentUsedMm, 250.5)
  assert.equal(first?.printDuration, 1001)
  assert.equal(first?.startedAt, Math.round(job(1).start_time * 1000))
  assert.throws(() => parseMoonrakerHistoryPage({}))
})

test('history pages are bounded in size and number', async () => {
  const requests: Record<string, unknown>[] = []
  const all = Array.from({ length: 400 }, (_, index) => job(index))
  const jobs = await readMoonrakerHistory(
    {
      async request(method, params) {
        assert.equal(method, 'server.history.list')
        requests.push(params as Record<string, unknown>)
        const { start, limit } = params as { start: number; limit: number }
        return { jobs: all.slice(start, start + limit) }
      },
    },
    { sinceMs: 0 },
  )
  assert.equal(requests.length, HISTORY_MAX_PAGES)
  assert.ok(requests.every((value) => value.limit === HISTORY_PAGE_SIZE))
  assert.equal(jobs.length, HISTORY_MAX_PAGES * HISTORY_PAGE_SIZE)
})

test('a short page ends the read and old jobs are dropped', async () => {
  let calls = 0
  const jobs = await readMoonrakerHistory(
    {
      async request() {
        calls++
        return { jobs: [job(0), job(1)] }
      },
    },
    { sinceMs: (nowSeconds() - 4000) * 1000 },
  )
  assert.equal(calls, 1)
  assert.deepEqual(
    jobs.map((value) => value.filename),
    ['part-0.gcode'],
  )
})

test('quick back-to-back jobs stay distinct', () => {
  const dedup = createMoonrakerHistoryDedup()
  const { jobs } = parseMoonrakerHistoryPage({
    jobs: [
      job(0, { end_time: nowSeconds() - 600 }),
      job(1, { end_time: nowSeconds() - 590 }),
    ],
  })
  assert.equal(dedup.fresh('p', jobs).length, 2)
})

test('dedup keeps re-imports and live-recorded jobs out', () => {
  const dedup = createMoonrakerHistoryDedup()
  const { jobs } = parseMoonrakerHistoryPage({
    jobs: [job(0), job(1), job(2)],
  })
  const liveEnd = jobs[1]!.endedAt + 5000
  dedup.noteLive('p', liveEnd)
  const first = dedup.fresh('p', jobs)
  assert.deepEqual(
    first.map((value) => value.filename),
    ['part-2.gcode', 'part-0.gcode'],
  )
  assert.deepEqual(dedup.fresh('p', jobs), [])
  assert.equal(dedup.fresh('other', jobs).length, 3)
})

async function fixture(entries: Record<string, unknown>[]) {
  const historyRequests: URLSearchParams[] = []
  const peers = new Set<WsTestSocket>()
  let eventtime = 1
  const server = await serveWsTestServer({
    http(request) {
      const url = new URL(request.url)
      if (url.pathname === '/server/info')
        return Response.json({
          result: { klippy_connected: true, klippy_state: 'ready' },
        })
      if (url.pathname === '/server/history/list') {
        historyRequests.push(url.searchParams)
        const start = Number(url.searchParams.get('start') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return Response.json({
          result: {
            count: entries.length,
            jobs: entries.slice(start, start + limit),
          },
        })
      }
      return new Response('{}', { status: 404 })
    },
    upgrade: () => true,
    onOpen: (socket) => peers.add(socket),
    onClose: (socket) => peers.delete(socket),
    onMessage(socket, wire) {
      const request = JSON.parse(wire)
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result:
            request.method === 'server.connection.identify'
              ? { connection_id: 1 }
              : {
                  eventtime: eventtime++,
                  status: {
                    webhooks: { state: 'ready' },
                    print_stats: { state: 'standby' },
                    virtual_sdcard: { progress: 0 },
                  },
                },
        }),
      )
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    historyRequests,
    dropConnections() {
      for (const peer of peers) peer.terminate()
    },
    close: () => server.stop(),
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 6000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function collect(
  entries: Record<string, unknown>[],
  run: (context: {
    fixture: Awaited<ReturnType<typeof fixture>>
    queue: TelemetryQueue
    jobs: () => NonNullable<PrinterState['lastJob']>[]
  }) => Promise<void>,
  options: { importMoonrakerHistory: boolean } = {
    importMoonrakerHistory: true,
  },
) {
  const server = await fixture(entries)
  const dir = mkdtempSync(join(tmpdir(), 'history-import-'))
  const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
  const seen: NonNullable<PrinterState['lastJob']>[] = []
  const controller = new AbortController()
  const done = collectIntoQueue({
    config: {
      version: 1,
      allowedOrigins: [server.origin],
      printers: [{ printerKey: 'printer', origin: server.origin }],
      limits: {
        maxMessageBytes: 4096,
        connectTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        staleAfterMs: 30000,
        reconnectMinMs: 100,
        reconnectMaxMs: 200,
      },
    },
    ...options,
    queue,
    signal: controller.signal,
    onDiagnostic() {},
  })
  try {
    await run({
      fixture: server,
      queue,
      jobs() {
        // Drain the queue into `seen`; nothing recorded is ever lost from it.
        for (;;) {
          const { records } = queue.batch(Date.now())
          if (!records.length) break
          queue.acknowledge(
            records.map((record) => record.eventId),
            Date.now(),
          )
          for (const record of records)
            if (record.kind === 'printer-state' && record.state.lastJob)
              seen.push(record.state.lastJob)
        }
        return seen
      },
    })
  } finally {
    controller.abort()
    await done
    await server.close()
    queue.close()
    rmSync(dir, { recursive: true })
  }
}

test('imports missing finished jobs once and again after a reconnect', async () => {
  const entries = [
    job(0),
    job(1, { status: 'cancelled' }),
    job(2, { status: 'in_progress', end_time: null }),
  ]
  await collect(entries, async ({ fixture: server, jobs }) => {
    await waitFor(() => jobs().length === 2)
    assert.deepEqual(
      jobs()
        .map((value) => [value.filename, value.outcome])
        .sort(),
      [
        ['part-0.gcode', 'completed'],
        ['part-1.gcode', 'cancelled'],
      ],
    )
    const first = server.historyRequests[0]!
    assert.equal(first.get('limit'), String(HISTORY_PAGE_SIZE))
    assert.equal(first.get('order'), 'desc')
    const before = server.historyRequests.length
    server.dropConnections()
    await waitFor(() => server.historyRequests.length > before)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(jobs().length, 2)
  })
})

test('a reconnect during an import schedules another import after a live state', async () => {
  let requests = 0
  let release: (() => void) | undefined
  const server = createServer((_request, response) => {
    requests++
    const send = () =>
      response.end(JSON.stringify({ result: { jobs: [job(0)] } }))
    if (requests === 1) release = send
    else send()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture address')
  const controller = new AbortController()
  const recorded: PrinterState[] = []
  const history = createMoonrakerHistoryImport({
    printerKey: 'printer',
    selected: {
      printerKey: 'printer',
      origin: `http://127.0.0.1:${address.port}`,
      limits: {
        maxMessageBytes: 4096,
        connectTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        staleAfterMs: 30000,
        reconnectMinMs: 100,
        reconnectMaxMs: 200,
      },
    },
    signal: controller.signal,
    record: (state) => recorded.push(state),
  })
  try {
    history.observe('idle')
    await waitFor(() => release !== undefined)
    history.reconnecting()
    history.observe('idle')
    release!()
    await history.settled()
    assert.equal(requests, 2)
    assert.equal(recorded.length, 1)
  } finally {
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('history import reads at most the bounded number of pages', async () => {
  const entries = Array.from({ length: 300 }, (_, index) =>
    job(index, { end_time: nowSeconds() - 600 - index }),
  )
  await collect(entries, async ({ fixture: server, jobs }) => {
    await waitFor(() => jobs().length === HISTORY_MAX_PAGES * HISTORY_PAGE_SIZE)
    assert.equal(server.historyRequests.length, HISTORY_MAX_PAGES)
  })
})

test('history is not read unless enabled', async () => {
  await collect(
    [job(0)],
    async ({ fixture: server, jobs }) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(server.historyRequests.length, 0)
      assert.equal(jobs().length, 0)
    },
    { importMoonrakerHistory: false },
  )
})
