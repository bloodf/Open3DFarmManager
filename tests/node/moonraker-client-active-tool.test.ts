import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serveWsTestServer, type WsTestSocket } from '../unit/ws-serve.ts'
import {
  openMoonrakerClient,
  type MoonrakerCompleteObservation,
} from '../../packages/connector/src/moonraker/client.ts'
import { SNAPMAKER_U1_STATUS_OBJECTS } from '../../packages/connector/src/moonraker/u1-tools.ts'
import {
  createMoonrakerSubscription,
  type RawMoonrakerObservation,
} from '../../packages/connector/src/moonraker/subscription.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type { CompleteFarmSnapshot } from '../../packages/connector/src/webrtc/farm-status-sender.ts'

const limits = {
  maxMessageBytes: 8192,
  connectTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  staleAfterMs: 5000,
  reconnectMinMs: 100,
  reconnectMaxMs: 1000,
}
const baseStatus = {
  webhooks: { state: 'ready' },
  print_stats: { state: 'printing' },
  virtual_sdcard: { progress: 0.25 },
}

type Rpc = {
  id: number
  method: string
  params?: { objects?: Record<string, string[]> }
}
type Handlers = {
  http?: (
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>
  list?: (socket: WsTestSocket, rpc: Rpc) => void
  status?: (rpc: Rpc) => Record<string, unknown>
  respond?: (socket: WsTestSocket, rpc: Rpc, send: () => void) => void
  replyMetadata?: { cli_time: number; dev_time: number }
}

/** Loopback Moonraker; the object list and complete-query timing are scripted. */
async function moonraker(objects: string[], handlers: Handlers = {}) {
  const rpcs: Rpc[] = []
  const server = await serveWsTestServer({
    async http(request) {
      return (
        (await handlers.http?.(request)) ??
        (new URL(request.url).pathname === '/server/info'
          ? Response.json({
              result: { klippy_connected: true, klippy_state: 'ready' },
            })
          : new Response(null, { status: 404 }))
      )
    },
    upgrade: () => true,
    onMessage(socket, wire) {
      const rpc = JSON.parse(wire) as Rpc
      if (rpc.method === 'server.connection.identify')
        return socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { connection_id: 1 },
            ...handlers.replyMetadata,
          }),
        )
      rpcs.push(rpc)
      if (rpc.method === 'printer.objects.list') {
        if (handlers.list) return handlers.list(socket, rpc)
        return socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { objects },
            ...handlers.replyMetadata,
          }),
        )
      }
      const send = () =>
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            // The eventtime names the request that produced this reply.
            result: {
              eventtime: rpcs.length,
              status: { ...baseStatus, ...handlers.status?.(rpc) },
            },
            ...handlers.replyMetadata,
          }),
        )
      if (handlers.respond) handlers.respond(socket, rpc, send)
      else send()
    },
  })
  return {
    rpcs,
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  }
}

function open(
  origin: string,
  onComplete: (value: MoonrakerCompleteObservation) => void,
  discoverObjects: boolean,
) {
  const controller = new AbortController()
  const client = openMoonrakerClient({
    origin,
    limits,
    signal: controller.signal,
    discoverObjects,
    onStatus() {},
    onComplete,
  })
  return {
    client,
    async stop() {
      controller.abort()
      client.close()
      await client.closed
    },
  }
}

function queries(rpcs: Rpc[]) {
  return rpcs.filter((rpc) => rpc.method === 'printer.objects.query')
}

async function until(condition: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for the fixture')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('U1 HTTP inventory and refresh keep a push-only WebSocket farm feed live and fresh', async () => {
  const status = {
    webhooks: { state: 'ready' },
    print_stats: {
      filename: 'simulator-cube.gcode',
      state: 'complete',
      print_duration: 60,
      total_duration: 70,
      filament_used: 20,
      info: { current_layer: 20, total_layer: 20 },
    },
    virtual_sdcard: { progress: 1 },
    extruder: { temperature: 24, target: 0 },
    extruder1: { temperature: 25, target: 0 },
    extruder2: { temperature: 26, target: 0 },
    extruder3: { temperature: 27, target: 0 },
    toolhead: { extruder: 'extruder3' },
    heater_bed: { temperature: 28, target: 0 },
    fan: { speed: 0.4 },
    'fan_generic cavity_fan': { speed: 0 },
  }
  const delayedAt: number[] = []
  const httpRequests: string[] = []
  const selectedObjects: Record<string, string>[] = []
  const objects = Object.keys(status)
  let connected: WsTestSocket | undefined
  let holdPoll = false
  let releasePendingPoll: (() => void) | undefined
  const service = await moonraker(objects, {
    replyMetadata: { cli_time: -1, dev_time: 1 },
    status: () => status,
    http(request) {
      const url = new URL(request.url)
      httpRequests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === '/printer/objects/list')
        return Response.json({ result: { objects } })
      if (url.pathname !== '/printer/objects/query') return
      selectedObjects.push(Object.fromEntries(url.searchParams))
      const response = Response.json({
        result: { eventtime: selectedObjects.length + 1, status },
      })
      if (holdPoll)
        return new Promise((resolve) => {
          releasePendingPoll = () => resolve(response)
        })
      if (delayedAt.length === 2) return response
      delayedAt.push(performance.now())
      // The real U1 emits process stats while idle. These give no status
      // evidence while the complete HTTP snapshot is still in flight.
      connected?.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notify_proc_stat_update',
          params: [{ websocket_connections: 1 }],
        }),
      )
      return new Promise((resolve) => setTimeout(resolve, 1300, response))
    },
    respond(socket, rpc, send) {
      if (rpc.method !== 'printer.objects.subscribe') return
      connected = socket
      send()
    },
  })
  const agentId = randomUUID()
  const assignmentRefs = [
    { assignmentId: randomUUID(), agentId, printerKey: 'u1' },
  ]
  const source = createFarmSnapshotSource({ assignmentRefs })
  const controller = new AbortController()
  const raw: RawMoonrakerObservation[] = []
  const live: CompleteFarmSnapshot[] = []
  let unavailable = 0
  const reasons: string[] = []
  const subscription = createMoonrakerSubscription({
    assignment: {
      printerKey: 'u1',
      origin: service.origin,
      model: 'Snapmaker U1',
    },
    allowedOrigins: [service.origin],
    limits: {
      ...limits,
      requestTimeoutMs: 5000,
      staleAfterMs: 30000,
      reconnectMinMs: 10_000,
      reconnectMaxMs: 10_000,
    },
    discoverObjects: true,
    jobFields: true,
    signal: controller.signal,
    onEvent(event) {
      if (event.kind === 'unavailable') reasons.push(event.reason)
    },
    onRawUnavailable(value) {
      source.invalidate(value)
    },
    onRawObservation(value) {
      raw.push(value)
      source.observe(value)
      if (raw.length !== 1) return
      source.open({
        binding: { agent_id: agentId } as never,
        deadlineMonoMs: performance.now() + 12_000,
        assignmentRefs,
        signal: controller.signal,
        onComplete(snapshot) {
          live.push(snapshot)
        },
        onUnavailable() {
          unavailable++
        },
      })
    },
  })
  try {
    await until(
      () =>
        unavailable > 0 ||
        (live.length > 1 && performance.now() > live[0]!.validUntilMonoMs),
      10000,
    )
    assert.equal(unavailable, 0, 'the original read-only feed remained live')
    assert.deepEqual(httpRequests.slice(0, 3), [
      'GET /server/info',
      'GET /printer/objects/list',
      'GET /printer/objects/query',
    ])
    assert.deepEqual(
      service.rpcs.map(({ method }) => method),
      ['printer.objects.subscribe'],
    )
    const projected = {
      webhooks: ['state'],
      print_stats: [
        'state',
        'filename',
        'print_duration',
        'total_duration',
        'filament_used',
        'info',
      ],
      virtual_sdcard: ['progress'],
      extruder: ['temperature', 'target'],
      extruder1: ['temperature', 'target'],
      extruder2: ['temperature', 'target'],
      extruder3: ['temperature', 'target'],
      heater_bed: ['temperature', 'target'],
      toolhead: ['extruder'],
      fan: ['speed'],
      'fan_generic cavity_fan': ['speed'],
    }
    assert.deepEqual(service.rpcs[0]?.params?.objects, projected)
    assert.deepEqual(
      selectedObjects[0],
      Object.fromEntries(
        Object.entries(projected).map(([object, fields]) => [
          object,
          fields.join(','),
        ]),
      ),
    )
    assert.equal(delayedAt.length, 2)
    for (const [index, started] of delayedAt.entries()) {
      assert.equal(raw[index + 1]?.epoch, 1)
      const snapshot = live[index + 1]!
      assert.ok(snapshot.capturedAtMonoMs <= started)
      assert.equal(snapshot.validUntilMonoMs, snapshot.capturedAtMonoMs + 5000)
    }
    const delayedFrame = live[1]!
    assert.deepEqual(
      {
        state: delayedFrame.printers[0]?.state,
        nozzle: delayedFrame.printers[0]?.toolTemperatureCelsius,
        bed: delayedFrame.printers[0]?.bedTemperatureCelsius,
      },
      { state: 'idle', nozzle: 27, bed: 28 },
    )
    assert.deepEqual(raw[1]?.printer.materials, [
      { slot: 'T0', active: false },
      { slot: 'T1', active: false },
      { slot: 'T2', active: false },
      { slot: 'T3', active: true },
    ])
    const printer = raw[1]?.printer
    const stats = raw[1]?.status.print_stats
    assert.deepEqual(
      {
        filename: stats?.filename,
        progress: printer?.progress,
        printDuration: printer?.printDuration,
        totalDuration: stats?.total_duration,
        currentLayer: printer?.currentLayer,
        totalLayer: printer?.totalLayer,
        fans: printer?.fans,
        toolHeaters: printer?.toolHeaters?.map(({ tool }) => tool),
      },
      {
        filename: 'simulator-cube.gcode',
        progress: 1,
        printDuration: 60,
        totalDuration: 70,
        currentLayer: 20,
        totalLayer: 20,
        fans: { part: 40 },
        toolHeaters: [0, 1, 2, 3],
      },
    )

    assert.ok(connected)
    connected.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notify_status_update',
        params: [
          {
            print_stats: { state: 'paused' },
            virtual_sdcard: { progress: 0.5 },
          },
          selectedObjects.length + 1.5,
        ],
      }),
    )
    await until(() => live.at(-1)?.printers[0]?.state === 'paused')
    assert.equal(live.at(-1)?.printers[0]?.progress, 0.5)

    holdPoll = true
    await until(() => releasePendingPoll !== undefined)
    const earlierObservations = raw.length
    connected.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'notify_klippy_disconnected' }),
    )
    // Reaching the collector's terminal diagnostic requires the pending GET
    // to settle. The fixture deliberately hasn't produced its response yet.
    await until(() => reasons.includes('not-ready'))
    assert.equal(unavailable, 1)
    releasePendingPoll?.()
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(raw.length, earlierObservations)
  } finally {
    controller.abort()
    releasePendingPoll?.()
    await subscription.done
    source.close()
    await service.stop()
  }
})

test('a single-tool printer keeps the unchanged extruder and heater_bed query', async () => {
  for (const discover of [true, false]) {
    const service = await moonraker(['toolhead', 'extruder', 'heater_bed'], {
      status: () => ({
        extruder: { temperature: 210 },
        heater_bed: { temperature: 60 },
      }),
    })
    const seen: MoonrakerCompleteObservation[] = []
    const session = open(service.origin, (value) => seen.push(value), discover)
    try {
      await until(() => queries(service.rpcs).length >= 1 && seen.length >= 2)
      assert.deepEqual(queries(service.rpcs)[0]?.params?.objects, {
        webhooks: ['state'],
        print_stats: ['state'],
        virtual_sdcard: ['progress'],
        extruder: ['temperature'],
        heater_bed: ['temperature'],
      })
      assert.equal(
        seen.length > 0 && seen.every((o) => !o.activeToolQuery),
        true,
      )
    } finally {
      await session.stop()
      await service.stop()
    }
  }
})

test('multi-tool discovery queries every extruder and the toolhead selection', async () => {
  const service = await moonraker(
    ['toolhead', 'extruder', 'extruder1', 'extruder3', 'heater_bed', 'fan'],
    {
      status: (rpc) =>
        rpc.params?.objects?.toolhead
          ? {
              toolhead: { extruder: 'extruder1' },
              extruder: { temperature: 20 },
              extruder1: { temperature: 230 },
              extruder3: { temperature: 25 },
              heater_bed: { temperature: 60 },
            }
          : {},
    },
  )
  const seen: MoonrakerCompleteObservation[] = []
  const session = open(service.origin, (value) => seen.push(value), true)
  try {
    await until(() => seen.some((o) => o.activeToolQuery))
    const query = queries(service.rpcs)[0]
    assert.deepEqual(query?.params?.objects, {
      webhooks: ['state'],
      print_stats: ['state'],
      virtual_sdcard: ['progress'],
      heater_bed: ['temperature'],
      fan: ['speed'],
      extruder: ['temperature'],
      extruder1: ['temperature'],
      extruder3: ['temperature'],
      toolhead: ['extruder'],
    })
    // The subscription itself never carries the temperature or toolhead fields.
    const subscribe = service.rpcs.find(
      (rpc) => rpc.method === 'printer.objects.subscribe',
    )
    assert.equal(
      Object.hasOwn(subscribe?.params?.objects ?? {}, 'toolhead'),
      false,
    )
    assert.equal(
      Object.hasOwn(subscribe?.params?.objects ?? {}, 'extruder1'),
      false,
    )
    const active = seen.find((o) => o.activeToolQuery)
    assert.deepEqual(
      (active?.result as { status: { toolhead: unknown } }).status.toolhead,
      { extruder: 'extruder1' },
    )
  } finally {
    await session.stop()
    await service.stop()
  }
})

test('the active-tool flag is captured when the query is sent, not when the reply lands', async () => {
  let held: (() => void) | undefined
  let released = false
  const service = await moonraker(['toolhead', 'extruder', 'extruder1'], {
    // Discovery answers only after the first plain query is in flight.
    list(socket, rpc) {
      const answer = () =>
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { objects: ['toolhead', 'extruder', 'extruder1'] },
          }),
        )
      const wait = setInterval(() => {
        if (!held) return
        clearInterval(wait)
        answer()
        // The reply to the already-sent plain query follows discovery.
        setTimeout(() => {
          released = true
          held?.()
        }, 40)
      }, 10)
    },
    respond(_socket, rpc, send) {
      const isPlainQuery =
        rpc.method === 'printer.objects.query' &&
        !rpc.params?.objects?.toolhead &&
        !released
      if (isPlainQuery && !held) held = send
      else send()
    },
    status: (rpc) =>
      rpc.params?.objects?.toolhead
        ? {
            toolhead: { extruder: 'extruder1' },
            extruder1: { temperature: 230 },
          }
        : {},
  })
  const seen: MoonrakerCompleteObservation[] = []
  const session = open(service.origin, (value) => seen.push(value), true)
  try {
    await until(() => seen.some((o) => o.activeToolQuery))
    // Every observation reports the shape of the request that produced it.
    const requested = service.rpcs.filter(
      (rpc) => rpc.method !== 'printer.objects.list',
    )
    const flagged = seen.map((o) => [
      (o.result as { eventtime: number }).eventtime,
      o.activeToolQuery,
    ])
    // The held reply was a plain query answered after discovery rewrote the
    // query objects; it must not claim the active tool was selected.
    const plain = flagged.filter(([, flag]) => !flag)
    assert.ok(plain.length >= 2, 'subscription and in-flight reply stay plain')
    assert.equal(queries(service.rpcs)[0]?.params?.objects?.toolhead, undefined)
    const later = queries(service.rpcs).find((q) => q.params?.objects?.toolhead)
    assert.ok(later, 'a later query selects the toolhead')
    assert.ok(
      requested.indexOf(later) > requested.indexOf(queries(service.rpcs)[0]!),
    )
    for (const [index, observation] of seen.entries())
      if (observation.activeToolQuery)
        assert.ok(index >= 3, 'only post-discovery queries are active')
  } finally {
    await session.stop()
    await service.stop()
  }
})

test('an overlapping active-tool query clears a stale nozzle reading', async () => {
  let queryCount = 0
  const service = await moonraker(['toolhead', 'extruder', 'extruder1'], {
    respond(socket, rpc, send) {
      if (
        rpc.method !== 'printer.objects.query' ||
        !rpc.params?.objects?.toolhead
      )
        return send()
      queryCount++
      if (queryCount === 1) return send()
      // A newer progress delta lands while this query is in flight.
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_status_update',
              params: [{ virtual_sdcard: { progress: 0.5 } }, 1000],
            }),
          ),
        10,
      )
      setTimeout(send, 40)
    },
    status: (rpc) => {
      if (!rpc.params?.objects?.toolhead) return {}
      // Query 1 reads extruder1. Query 2 has no tool or bed reading at all, so
      // only the active-tool flag can make it publish and clear the old value.
      return queryCount === 1
        ? {
            toolhead: { extruder: 'extruder1' },
            extruder1: { temperature: 230 },
            heater_bed: { temperature: 60 },
          }
        : {
            toolhead: { extruder: 'extruder' },
          }
    },
  })
  const raw: RawMoonrakerObservation[] = []
  const controller = new AbortController()
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'tool-printer', origin: service.origin },
    allowedOrigins: [service.origin],
    limits,
    discoverObjects: true,
    onEvent() {},
    onRawObservation(value) {
      raw.push(value)
    },
    signal: controller.signal,
  })
  try {
    await until(() =>
      raw.some(
        (o, index) =>
          o.temperatureObservation?.fields.tool.kind === 'absent' &&
          raw
            .slice(0, index)
            .some(
              (earlier) =>
                earlier.temperatureObservation?.fields.tool.kind === 'reading',
            ),
      ),
    )
    const readings = raw.flatMap(
      (o) => o.temperatureObservation?.fields.tool ?? [],
    )
    assert.deepEqual(
      readings.find((tool) => tool.kind === 'reading'),
      {
        kind: 'reading',
        celsius: 230,
      },
    )
    // The progress delta kept its newer value while the temperature cleared.
    const cleared = raw.find(
      (o, index) =>
        o.temperatureObservation?.fields.tool.kind === 'absent' &&
        raw
          .slice(0, index)
          .some(
            (e) => e.temperatureObservation?.fields.tool.kind === 'reading',
          ),
    )
    assert.equal(cleared?.printer.progress, 0.5)
    assert.deepEqual(cleared?.temperatureObservation?.fields.bed, {
      kind: 'absent',
    })
  } finally {
    controller.abort()
    await subscription.done
    await service.stop()
  }
})

test('discovery keeps the fields a Snapmaker U1 subscription already selected', async () => {
  const service = await moonraker(
    ['toolhead', 'extruder', 'extruder1', 'extruder2', 'extruder3'],
    {
      status: (rpc) =>
        rpc.params?.objects?.toolhead
          ? { toolhead: { extruder: 'extruder2' } }
          : {},
    },
  )
  const controller = new AbortController()
  const seen: MoonrakerCompleteObservation[] = []
  const client = openMoonrakerClient({
    origin: service.origin,
    limits,
    signal: controller.signal,
    discoverObjects: true,
    extraObjects: SNAPMAKER_U1_STATUS_OBJECTS,
    onStatus() {},
    onComplete: (value) => seen.push(value),
  })
  try {
    await until(() => seen.length >= 2)
    const objects = queries(service.rpcs)[0]?.params?.objects
    for (const name of ['extruder', 'extruder1', 'extruder2', 'extruder3'])
      assert.deepEqual(objects?.[name], ['temperature', 'target'], name)
    assert.deepEqual(objects?.toolhead, ['extruder'])
  } finally {
    controller.abort()
    client.close()
    await client.closed
    await service.stop()
  }
})

for (const inventoryDelay of [0, 150]) {
  test(`Snapmaker U1 observes T2 on connect and reconnect with a ${inventoryDelay} ms HTTP inventory`, async () => {
    const objects = [
      'toolhead',
      'extruder',
      'extruder1',
      'extruder2',
      'extruder3',
    ]
    let inventoryReads = 0
    let connectedSocket: WsTestSocket | undefined
    const service = await moonraker(objects, {
      async http(request) {
        const url = new URL(request.url)
        if (url.pathname !== '/printer/objects/list') return
        inventoryReads++
        if (inventoryDelay)
          await new Promise((resolve) => setTimeout(resolve, inventoryDelay))
        return Response.json({ result: { objects } })
      },
      respond(socket, rpc, send) {
        if (rpc.method !== 'printer.objects.subscribe') return
        connectedSocket = socket
        send()
      },
      status: (rpc) =>
        rpc.params?.objects?.toolhead?.includes('extruder')
          ? {
              toolhead: { extruder: 'extruder2' },
              extruder: { temperature: 210 },
              extruder2: { temperature: 245 },
            }
          : {},
    })
    const controller = new AbortController()
    const observations: RawMoonrakerObservation[] = []
    const subscription = createMoonrakerSubscription({
      assignment: {
        printerKey: 'snapmaker-u1',
        model: 'Snapmaker U1',
        origin: service.origin,
      },
      allowedOrigins: [service.origin],
      limits,
      discoverObjects: true,
      onEvent() {},
      onRawObservation(value) {
        observations.push(value)
      },
      signal: controller.signal,
    })
    try {
      const reading = { kind: 'reading', celsius: 245 }
      let previousEpoch: RawMoonrakerObservation['epoch'] | undefined
      for (let connection = 0; connection < 2; connection++) {
        const start = observations.length
        await until(() => observations.length > start)
        const first = observations[start]
        assert.ok(first)
        assert.notEqual(first.epoch, previousEpoch)
        assert.deepEqual(first.temperatureObservation?.fields.tool, reading)
        previousEpoch = first.epoch
        assert.equal(inventoryReads, connection + 1)
        assert.deepEqual(
          service.rpcs.map(({ method }) => method),
          Array.from(
            { length: connection + 1 },
            () => 'printer.objects.subscribe',
          ),
        )
        assert.ok(connectedSocket)
        connectedSocket.terminate()
      }
    } finally {
      controller.abort()
      await subscription.done
      await service.stop()
    }
  })
}
