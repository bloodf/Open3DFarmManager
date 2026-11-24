import assert from 'node:assert/strict'
import fs, { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { withCollectionHold } from '../../packages/connector/src/control/queue-collection-hold.ts'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'
import type { PauseDriver } from '../../packages/connector/src/control/pause-dispatcher.ts'
import type { PrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import {
  collectIntoQueue,
  type MoonrakerCollectionRefresh,
} from '../../packages/connector/src/runtime/collect.ts'
import { serveWsTestServer, type WsTestSocket } from '../unit/ws-serve.ts'
import type { PrinterState } from '../../packages/farm-protocol/src/state.ts'

const status = {
  webhooks: { state: 'ready' },
  print_stats: { state: 'complete' },
  virtual_sdcard: { progress: 1 },
}
const held = ['pause', 'confirm_collection']
const released = ['pause', 'start_print']

async function until<T>(
  read: () => T | undefined,
  message: string,
): Promise<T> {
  const deadline = performance.now() + 4500
  while (performance.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await delay(10)
  }
  assert.fail(message)
}

function resource(value: object) {
  if (process.env.MOONRAKER_TEST_LEDGER)
    appendFileSync(
      process.env.MOONRAKER_TEST_LEDGER,
      JSON.stringify(value) + '\n',
    )
}

async function fixture() {
  const requests: {
    method: string
    socket: WsTestSocket
    reply: (eventtime: number) => void
  }[] = []
  const unexpected: string[] = []
  const server = await serveWsTestServer({
    http(request) {
      const path = new URL(request.url).pathname
      if (path !== '/server/info' || request.method !== 'GET') {
        unexpected.push(`${request.method} ${path}`)
        return new Response(null, { status: 404 })
      }
      return Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      })
    },
    upgrade: () => true,
    onMessage(socket, wire) {
      const { method, id } = JSON.parse(wire)
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
      if (method === 'server.connection.identify')
        return reply({ connection_id: 1 })
      if (
        method !== 'printer.objects.subscribe' &&
        method !== 'printer.objects.query'
      ) {
        unexpected.push(method)
        return
      }
      requests.push({
        method,
        socket,
        reply: (eventtime) => reply({ eventtime, status }),
      })
    },
  })
  resource({ kind: 'loopback', id: server.port, state: 'created' })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async request(index: number, method: 'subscribe' | 'query') {
      const request = await until(() => requests[index], `Missing ${method}`)
      assert.equal(request.method, `printer.objects.${method}`)
      return request
    },
    async close() {
      await server.stop()
      resource({ kind: 'loopback', id: server.port, state: 'closed' })
      assert.deepEqual(unexpected, [])
    },
  }
}

function setup(
  directory: string,
  printers: { printerKey: string; origin: string }[],
) {
  const journalPath = join(directory, 'collection.json')
  const pending = new Map<string, MoonrakerCollectionRefresh>(
    printers.map(({ printerKey }) => [printerKey, {}]),
  )
  const releases: string[] = []
  const journal = openQueueCollectionJournal(journalPath, (key) => {
    releases.push(key)
    const refresh = pending.get(key)!
    refresh.releasedAtMonoMs = performance.now()
    refresh.request?.()
  })
  for (const { printerKey } of printers) journal.complete(printerKey, '20')
  const baseDriver: PauseDriver = {
    controls: () => ['pause', 'start_print'],
    async execute() {
      assert.fail('Collection confirmation reached the printer driver')
    },
    async pauseOnce() {
      assert.fail('Unexpected pause')
    },
    async waitForPaused() {
      assert.fail('Unexpected wait for pause')
    },
  }
  const driver = withCollectionHold(baseDriver, {
    journal,
    printerKey: (binding) => (binding as unknown as { key: string }).key,
  })
  const binding = (key: string) => ({ key }) as unknown as PrinterBinding
  const queue = new TelemetryQueue(join(directory, 'telemetry'), Date.now())
  const controller = new AbortController()
  const observed: PrinterState[] = []
  let refreshCachedControls: (() => void) | undefined
  const collection = collectIntoQueue({
    config: {
      version: 1,
      allowedOrigins: printers.map(({ origin }) => origin),
      printers,
      limits: {
        maxMessageBytes: 8192,
        connectTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        staleAfterMs: 5000,
        reconnectMinMs: 100,
        reconnectMaxMs: 100,
      },
    },
    queue,
    signal: controller.signal,
    moonrakerCollectionRefresh: pending,
    controlsFor: (key) => driver.controls!(binding(key)),
    onPrinterState: (state) => {
      observed.push(state)
    },
    onControlsRefresh(refresh) {
      refreshCachedControls = refresh
    },
    onDiagnostic() {},
  })
  return {
    queue,
    pending,
    releases,
    observed,
    refreshCachedControls: () => refreshCachedControls?.(),
    blocked: (key: string) =>
      openQueueCollectionJournal(journalPath).blocked(key),
    confirm(key: string, attempt: string, allowed = true) {
      return driver.execute!(
        'confirm_collection',
        { attempt },
        {
          binding: binding(key),
          beforeSend: () => allowed,
          signal: controller.signal,
        },
      )
    },
    states(key: string) {
      return queue
        .batch(Date.now())
        .records.flatMap((record) =>
          record.kind === 'printer-state' && record.state.printerKey === key
            ? [record.state]
            : [],
        )
    },
    async close() {
      controller.abort()
      try {
        await collection
      } finally {
        queue.close()
      }
    },
  }
}

async function startRuntime(t: TestContext, keys: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'moonraker-collection-refresh-'))
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
  let runtime: ReturnType<typeof setup> | undefined
  t.after(async () => {
    try {
      await runtime?.close()
    } finally {
      try {
        await Promise.all(fixtures.map((server) => server.close()))
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
  for (const _ of keys) fixtures.push(await fixture())
  runtime = setup(
    directory,
    keys.map((printerKey, i) => ({
      printerKey,
      origin: fixtures[i]!.origin,
    })),
  )
  return { directory, runtime, fixtures }
}

test('an idle connection records unchanged status after an immediate release read', async (t) => {
  const {
    runtime,
    fixtures: [a],
  } = await startRuntime(t, ['a'])
  assert.ok(a)
  const initial = await a.request(0, 'subscribe')
  initial.reply(10)
  const first = await until(() => runtime.states('a')[0], 'Initial state')
  assert.deepEqual(first.controls, held)

  const releasedAt = performance.now()
  assert.equal((await runtime.confirm('a', '20')).acknowledged, true)
  const immediate = await a.request(1, 'query')
  assert.ok(
    performance.now() - releasedAt < 800,
    'Read scheduled before normal cadence',
  )
  const sentAt = Date.now()
  immediate.reply(10)
  const second = await until(() => runtime.states('a')[1], 'Release snapshot')
  assert.deepEqual(second, {
    ...first,
    controls: released,
    observedAt: second.observedAt,
  })
  assert.ok(second.observedAt >= sentAt && second.observedAt > first.observedAt)
  assert.equal(runtime.pending.get('a')?.releasedAtMonoMs, undefined)
})

test('a pre-release startup request reports unaffected controls until the next read', async (t) => {
  const {
    runtime,
    fixtures: [a],
  } = await startRuntime(t, ['a'])
  assert.ok(a)
  const initial = await a.request(0, 'subscribe')
  assert.equal((await runtime.confirm('a', '20')).acknowledged, true)
  initial.reply(10)
  const first = await until(() => runtime.states('a')[0], 'Startup snapshot')
  assert.deepEqual(first.controls, ['pause'])
  assert.ok(runtime.pending.get('a')?.releasedAtMonoMs !== undefined)

  const next = await a.request(1, 'query')
  next.reply(10)
  const second = await until(() => runtime.states('a')[1], 'Release snapshot')
  assert.deepEqual(second.controls, released)
  assert.equal(runtime.pending.get('a')?.releasedAtMonoMs, undefined)
})

test('collection release publishes an unchanged complete read for that printer only', async (t) => {
  const {
    runtime,
    fixtures: [a, b],
  } = await startRuntime(t, ['a', 'b'])
  assert.ok(a && b)
  const [initialA, initialB] = await Promise.all([
    a.request(0, 'subscribe'),
    b.request(0, 'subscribe'),
  ])
  initialA.reply(10)
  initialB.reply(10)
  const firstA = await until(() => runtime.states('a')[0], 'Initial state')
  assert.deepEqual(firstA.controls, held)
  assert.deepEqual(
    (await until(() => runtime.states('b')[0], 'Other printer')).controls,
    held,
  )
  assert.equal((await runtime.confirm('a', '20', false)).acknowledged, false)
  await runtime.confirm('a', '19')
  assert.deepEqual(runtime.releases, [])
  assert.equal(runtime.blocked('a'), true)

  const [oldA, firstB] = await Promise.all([
    a.request(1, 'query'),
    b.request(1, 'query'),
  ])
  assert.equal((await runtime.confirm('a', '20')).acknowledged, true)
  await runtime.confirm('a', '20')
  assert.deepEqual(runtime.releases, ['a'])
  assert.equal(runtime.blocked('a'), false)
  assert.equal(runtime.blocked('b'), true)
  runtime.refreshCachedControls()
  oldA.reply(10)
  firstB.reply(10)
  const [overlap, secondB] = await Promise.all([
    a.request(2, 'query'),
    b.request(2, 'query'),
  ])
  assert.deepEqual(runtime.states('a'), [firstA])
  assert.ok(runtime.pending.get('a')?.releasedAtMonoMs !== undefined)

  // This unchanged delta still establishes newer progress provenance, so the
  // overlapping complete response cannot consume the release.
  overlap.socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [{ virtual_sdcard: { progress: 1 } }, 11],
    }),
  )
  overlap.reply(10)
  secondB.reply(10)
  const [fresh, thirdB] = await Promise.all([
    a.request(3, 'query'),
    b.request(3, 'query'),
  ])
  assert.deepEqual(runtime.states('a'), [firstA])
  const sentAt = Date.now()
  fresh.reply(11)
  thirdB.reply(10)
  const secondA = await until(() => runtime.states('a')[1], 'Released controls')
  assert.deepEqual(secondA, {
    ...firstA,
    controls: released,
    observedAt: secondA.observedAt,
  })
  assert.ok(secondA.observedAt >= sentAt && secondA.observedAt <= Date.now())
  assert.equal(runtime.pending.get('a')?.releasedAtMonoMs, undefined)
  assert.equal(runtime.states('b').length, 1)

  const [nextA, nextB] = await Promise.all([
    a.request(4, 'query'),
    b.request(4, 'query'),
  ])
  nextA.reply(11)
  nextB.reply(10)
  await a.request(5, 'query')
  assert.equal(runtime.states('a').length, 2)
  assert.equal(runtime.states('b').length, 1)
})

test('release survives repeated disconnects, a timestamp tie, and a dropped write', async (t) => {
  const {
    directory,
    runtime,
    fixtures: [a],
  } = await startRuntime(t, ['a'])
  assert.ok(a)
  const initial = await a.request(0, 'subscribe')
  initial.reply(10)
  const first = await until(() => runtime.states('a')[0], 'Initial state')
  assert.deepEqual(first.controls, held)
  const releasedAt = performance.now()
  await runtime.confirm('a', '20')
  const inFlight = await a.request(1, 'query')
  assert.ok(
    performance.now() - releasedAt < 800,
    'Read scheduled before normal cadence',
  )
  inFlight.socket.terminate()
  const reconnect = await a.request(2, 'subscribe')
  const offline = runtime.observed.at(-1)
  assert.equal(offline?.state, 'offline')
  assert.ok(runtime.pending.get('a')?.releasedAtMonoMs !== undefined)

  // An online observation with the same wall time cannot replace the offline
  // row, but still reports the status and transition with safe capabilities.
  const wall = t.mock.method(Date, 'now', () => offline.observedAt)
  try {
    reconnect.reply(1)
    const online = await until(
      () => runtime.states('a')[2],
      'Colliding snapshot',
    )
    assert.equal(online.observedAt, offline.observedAt)
    assert.equal(online.state, first.state)
    assert.deepEqual(online.controls, ['pause'])
    assert.equal(runtime.observed.at(-1)?.state, first.state)
    assert.ok(
      runtime.queue
        .batch(Date.now())
        .records.some(
          (row) =>
            row.kind === 'printer-transition' &&
            row.transition.from === 'offline' &&
            row.transition.to === first.state &&
            row.transition.observedAt === offline.observedAt,
        ),
    )
    assert.ok(runtime.pending.get('a')?.releasedAtMonoMs !== undefined)
  } finally {
    wall.mock.restore()
  }

  reconnect.socket.terminate()
  const storageAttempt = await a.request(3, 'subscribe')
  const offlineAgain = runtime.observed.at(-1)
  assert.equal(offlineAgain?.state, 'offline')
  assert.ok(offlineAgain.observedAt > offline.observedAt)
  assert.equal(runtime.states('a')[3]?.observedAt, offlineAgain.observedAt)
  assert.ok(
    runtime.queue
      .batch(Date.now())
      .records.some(
        (row) =>
          row.kind === 'printer-transition' &&
          row.transition.from === first.state &&
          row.transition.to === 'offline' &&
          row.transition.observedAt === offlineAgain.observedAt,
      ),
  )
  assert.ok(runtime.pending.get('a')?.releasedAtMonoMs !== undefined)

  const logPath = join(directory, 'telemetry', 'telemetry.jsonl')
  const open = fs.openSync
  let appends = 0
  const fault = t.mock.method(
    fs,
    'openSync',
    (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (
        path === logPath &&
        typeof flags === 'number' &&
        flags & fs.constants.O_APPEND &&
        ++appends === 2
      )
        throw Object.assign(new Error('Simulated full disk'), {
          code: 'ENOSPC',
        })
      return open(path, flags, mode)
    },
  )
  syncBuiltinESMExports()
  t.after(() => {
    fault.mock.restore()
    syncBuiltinESMExports()
  })
  storageAttempt.reply(1)
  await until(
    () => (runtime.queue.storageLost > 0 ? true : undefined),
    'Dropped enqueue',
  )
  assert.ok(runtime.pending.get('a')?.releasedAtMonoMs !== undefined)
  assert.equal(runtime.queue.storageLost, 1)
  assert.equal(runtime.queue.storageDegraded, true)
  fault.mock.restore()
  syncBuiltinESMExports()
  assert.equal(runtime.queue.retryStorage(), true)
  assert.deepEqual(
    runtime.states('a').map((state) => state.controls),
    [held, undefined, ['pause'], undefined],
  )

  const next = await a.request(4, 'query')
  const sentAt = Date.now()
  next.reply(1)
  const last = await until(
    () => runtime.states('a')[4],
    'Release after storage recovery',
  )
  assert.deepEqual(last.controls, released)
  assert.ok(last.observedAt >= sentAt && last.observedAt <= Date.now())
  assert.equal(runtime.pending.get('a')?.releasedAtMonoMs, undefined)
  assert.deepEqual(runtime.releases, ['a'])
  assert.equal(runtime.blocked('a'), false)
})
