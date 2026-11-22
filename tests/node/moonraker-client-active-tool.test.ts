import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveWsTestServer, type WsTestSocket } from '../unit/ws-serve.ts'
import {
  openMoonrakerClient,
  type MoonrakerCompleteObservation,
} from '../../packages/connector/src/moonraker/client.ts'
import {
  createMoonrakerSubscription,
  type RawMoonrakerObservation,
} from '../../packages/connector/src/moonraker/subscription.ts'

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
  list?: (socket: WsTestSocket, rpc: Rpc) => void
  status?: (rpc: Rpc) => Record<string, unknown>
  respond?: (socket: WsTestSocket, rpc: Rpc, send: () => void) => void
}

/** Loopback Moonraker; the object list and complete-query timing are scripted. */
async function moonraker(objects: string[], handlers: Handlers = {}) {
  const rpcs: Rpc[] = []
  const server = await serveWsTestServer({
    http: () =>
      Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    upgrade: () => true,
    onMessage(socket, wire) {
      const rpc = JSON.parse(wire) as Rpc
      if (rpc.method === 'server.connection.identify')
        return socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { connection_id: 1 },
          }),
        )
      rpcs.push(rpc)
      if (rpc.method === 'printer.objects.list') {
        if (handlers.list) return handlers.list(socket, rpc)
        return socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { objects } }),
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
