import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import assert from 'node:assert/strict'
import { serveWsTestServer } from '../unit/ws-serve.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import type { MoonrakerEvent } from '../../packages/connector/src/moonraker/subscription.ts'

for (const present of [true, false]) {
  test(`Moonraker listed fan/light objects: ${present}`, async () => {
    const requests: {
      method: string
      params?: { objects: Record<string, string[]> }
    }[] = []
    const telemetry = present
      ? {
          fan: { speed: 0.42 },
          'fan_generic aux': { speed: 0.7 },
          'fan_generic chamber': { speed: 1 },
          'output_pin caselight': { value: 1 },
        }
      : {}
    const controller = new AbortController()
    const events: MoonrakerEvent[] = []
    const agent = randomUUID()
    const refs = [
      { assignmentId: randomUUID(), agentId: agent, printerKey: 'fixture' },
    ]
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const receivedRtc: CompleteFarmSnapshot[] = []

    let resolveSnapshot: () => void = () => {}
    let rawCount = 0
    let resolveQuery: () => void = () => {}
    const queried = new Promise<void>((resolve) => {
      resolveQuery = resolve
    })
    const received = new Promise<void>((resolve) => {
      resolveSnapshot = resolve
    })
    const fixture = await serveWsTestServer({
      http: () =>
        Response.json({
          result: { klippy_connected: true, klippy_state: 'ready' },
        }),
      upgrade: () => true,
      onMessage(socket, wire) {
        const request = JSON.parse(wire)
        requests.push(request)
        const result =
          request.method === 'printer.objects.list'
            ? {
                objects: [
                  'webhooks',
                  'print_stats',
                  'virtual_sdcard',
                  ...Object.keys(telemetry),
                ],
              }
            : {
                eventtime: request.method === 'printer.objects.query' ? 3 : 1,
                status: {
                  webhooks: { state: 'ready' },
                  print_stats: { state: 'printing' },
                  virtual_sdcard: { progress: 0.25 },
                  ...telemetry,
                  ...(present && request.method === 'printer.objects.query'
                    ? {
                        fan: { speed: 0.2 },
                        'output_pin caselight': { value: 1 },
                      }
                    : {}),
                },
              }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
        if (request.method === 'printer.objects.subscribe') {
          setTimeout(
            () =>
              socket.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notify_status_update',
                  params: [
                    present
                      ? {
                          fan: { speed: 0 },
                          'output_pin caselight': { value: 0 },
                        }
                      : { virtual_sdcard: { progress: 0.5 } },
                    2,
                  ],
                }),
              ),
            20,
          )
        }
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const subscription = createMoonrakerSubscription({
      assignment: { printerKey: 'fixture', origin },
      allowedOrigins: [origin],
      limits: {
        maxMessageBytes: 4096,
        connectTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        staleAfterMs: 5000,
        reconnectMinMs: 100,
        reconnectMaxMs: 1000,
      },
      onRawObservation(value) {
        source.observe(value)
        if (++rawCount === 3) resolveQuery()
      },
      discoverObjects: true,
      signal: controller.signal,
      onEvent(event) {
        events.push(event)
        if (events.filter((value) => value.kind === 'snapshot').length === 2)
          resolveSnapshot()
      },
    })
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      await Promise.race([
        received,
        subscription.done.then(() => {
          throw Error('Subscription ended before snapshots')
        }),
      ])
      assert.deepEqual(
        requests.map((request) => request.method),
        ['printer.objects.list', 'printer.objects.subscribe'],
      )
      assert.deepEqual(requests[1]?.params?.objects, {
        webhooks: ['state'],
        print_stats: ['state'],
        virtual_sdcard: ['progress'],
        ...(present
          ? {
              fan: ['speed'],
              'fan_generic aux': ['speed'],
              'fan_generic chamber': ['speed'],
              'output_pin caselight': ['value'],
            }
          : {}),
      })
      const snapshots = events.filter((event) => event.kind === 'snapshot')
      assert.equal(snapshots.length, 2)
      const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
        v: 1,
        purpose: 'read-only-rtc',
        transport_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: agent,
        account_id: 'account',
        key_id: randomUUID(),
        browser_public_key: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' },
        browser_thumbprint: 'test',
        connector_public_key_spki: 'test',
        connector_fingerprint: 'test',
        credential_jti: randomUUID(),
        origin: 'https://farm.example',
        audience: 'test',
        browser_nonce: 'test',
        connector_nonce: 'test',
        issued_at: 0,
        expires_at: 10000,
        commands_enabled: false,
        offer_sha256: 'test',
        answer_sha256: 'test',
        browser_dtls: 'test',
        connector_dtls: 'test',
      }
      const session = source.open({
        binding,
        assignmentRefs: refs,
        deadlineMonoMs: performance.now() + 10000,
        signal: controller.signal,
        onComplete(value) {
          receivedRtc.push(value)
        },
        onUnavailable() {
          throw Error('RTC snapshot unavailable')
        },
      })
      assert.equal(receivedRtc.length, 1)
      assert.deepEqual(
        receivedRtc[0]?.printers[0]?.fans,
        present ? { part: 0, aux: 70, chamber: 100 } : undefined,
      )
      assert.deepEqual(
        receivedRtc[0]?.printers[0]?.light,
        present ? { chamber: false } : undefined,
      )
      await Promise.race([
        queried,
        subscription.done.then(() => {
          throw Error('Subscription ended before query')
        }),
      ])
      assert.deepEqual(
        requests.map((request) => request.method),
        [
          'printer.objects.list',
          'printer.objects.subscribe',
          'printer.objects.query',
        ],
      )
      assert.deepEqual(requests[2]?.params?.objects, {
        ...requests[1]?.params?.objects,
        extruder: ['temperature'],
        heater_bed: ['temperature'],
      })
      assert.deepEqual(
        receivedRtc.at(-1)?.printers[0]?.fans,
        present ? { part: 20, aux: 70, chamber: 100 } : undefined,
      )
      assert.deepEqual(
        receivedRtc.at(-1)?.printers[0]?.light,
        present ? { chamber: true } : undefined,
      )
      session.close()

      assert.deepEqual(
        snapshots[0]?.printer.fans,
        present ? { part: 42, aux: 70, chamber: 100 } : undefined,
      )
      assert.deepEqual(
        snapshots[0]?.printer.light,
        present ? { chamber: true } : undefined,
      )
      assert.deepEqual(
        snapshots[1]?.printer.fans,
        present ? { part: 0, aux: 70, chamber: 100 } : undefined,
      )
      assert.deepEqual(
        snapshots[1]?.printer.light,
        present ? { chamber: false } : undefined,
      )
    } finally {
      clearTimeout(timeout)
      controller.abort()
      await subscription.done
      source.close()
      await fixture.stop()
    }
  })
}
