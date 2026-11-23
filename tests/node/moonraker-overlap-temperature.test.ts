import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serveWsTestServer } from '../unit/ws-serve.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
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

for (const kind of ['invalid', 'absent'] as const) {
  test(`overlapping single-extruder ${kind} temperature clears the reading and keeps the farm live`, async (t) => {
    let queries = 0
    let eventtime = 0
    const server = await serveWsTestServer({
      http: () =>
        Response.json({
          result: { klippy_connected: true, klippy_state: 'ready' },
        }),
      upgrade: () => true,
      onMessage(socket, wire) {
        const rpc = JSON.parse(wire)
        const reply = (result: unknown) =>
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
        if (rpc.method === 'server.connection.identify')
          return reply({ connection_id: 1 })
        const base = {
          webhooks: { state: 'ready' },
          print_stats: { state: 'printing' },
          virtual_sdcard: { progress: 0.25 },
        }
        if (rpc.method === 'printer.objects.subscribe')
          return reply({ eventtime: ++eventtime, status: base })
        if (rpc.method !== 'printer.objects.query') return
        queries++
        if (queries === 1)
          return reply({
            eventtime: ++eventtime,
            status: { ...base, extruder: { temperature: 210 } },
          })
        const progress = Math.min(0.99, 0.25 + queries / 100)
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'notify_status_update',
                params: [{ virtual_sdcard: { progress } }, ++eventtime],
              }),
            ),
          5,
        )
        setTimeout(
          () =>
            reply({
              eventtime: ++eventtime,
              status: {
                ...base,
                virtual_sdcard: { progress },
                ...(kind === 'invalid'
                  ? { extruder: { temperature: null } }
                  : {}),
              },
            }),
          30,
        )
      },
    })
    const agent = randomUUID()
    const refs = ['a', 'b'].map((printerKey) => ({
      assignmentId: randomUUID(),
      agentId: agent,
      printerKey,
    }))
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const snapshots: CompleteFarmSnapshot[] = []
    let unavailable = 0
    let readingAt = 0
    let evidence = false
    let opened = false
    const origin = `http://127.0.0.1:${server.port}`
    const controller = new AbortController()
    function observeB() {
      const now = performance.now()
      source.observe({
        printerKey: 'b',
        epoch: 1,
        printer: {
          printerKey: 'b',
          state: 'printing',
          progress: 0.2,
          observedAt: Date.now(),
        },
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: 'printing' },
          virtual_sdcard: { progress: 0.2 },
        },
        fieldObservedAtMonoMs: {
          webhooks: now,
          printState: now,
          progress: now,
        },
        receivedAtMonoMs: now,
      })
    }
    observeB()
    const subscription = createMoonrakerSubscription({
      assignment: { printerKey: 'a', origin },
      allowedOrigins: [origin],
      limits,
      onEvent() {},
      onRawObservation(value) {
        observeB()
        source.observe(value)
        if (value.temperatureObservation?.fields.tool.kind === 'reading') {
          readingAt = value.temperatureObservation.observedAtMonoMs
          if (!opened) {
            opened = true
            source.open({
              binding: { agent_id: agent } as never,
              deadlineMonoMs: performance.now() + 20000,
              assignmentRefs: refs,
              signal: controller.signal,
              onComplete(snapshot) {
                snapshots.push(snapshot)
              },
              onUnavailable() {
                unavailable++
              },
            })
          }
        }
        if (value.temperatureObservation?.fields.tool.kind === kind)
          evidence = true
      },
      signal: controller.signal,
    })
    try {
      const deadline = Date.now() + 10000
      while (
        (!readingAt || performance.now() < readingAt + 5300) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25))
      assert.ok(readingAt, 'initial reading was observed')
      assert.ok(
        snapshots.some(
          (s) =>
            s.printers.find((p) => p.printerKey === 'a')
              ?.toolTemperatureCelsius === 210,
        ),
        'initial reading reached the farm',
      )
      assert.ok(
        performance.now() >= readingAt + 5000,
        'checked after the reading expired',
      )
      await t.test('replaces the old temperature', () => {
        assert.ok(evidence, `${kind} evidence replaced the old reading`)
        assert.equal(
          snapshots.at(-1)?.printers.find((p) => p.printerKey === 'a')
            ?.toolTemperatureCelsius,
          undefined,
          'old reading was removed from the farm',
        )
      })
      await t.test(
        'keeps the two-printer farm available after five seconds',
        () => {
          assert.equal(unavailable, 0, 'farm remained available')
          assert.equal(snapshots.at(-1)?.printers.length, 2)
        },
      )
    } finally {
      controller.abort()
      await subscription.done
      source.close()
      await server.stop()
    }
  })
}
