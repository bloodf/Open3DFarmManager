import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  CompleteFarmSnapshot,
  FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { serveWsTestServer } from '../unit/ws-serve.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import { controlActionAvailability } from '../../apps/farm/app/utils/farm-control.ts'
import { liveReplayInfo } from '../../apps/farm/app/utils/replay-live.ts'
import type {
  FarmRow,
  FarmKeyState,
} from '../../apps/farm/app/utils/farm-view.ts'

// Fixture follows Snapmaker/u1-klipper print_stats.py at
// 93cb12faebf6e74c51bbc5f0be66e95124af14c8 and the status subscription in
// OrcaSlicer MoonrakerPrinterAgent.cpp at f92a7c065c5718b8ef1baac1cd704df2911238f4.

type WireState =
  'standby' | 'printing' | 'paused' | 'error' | 'complete' | 'cancelled'

const cases = [
  { wire: 'complete', outcome: 'completed', state: 'idle' },
  { wire: 'cancelled', outcome: 'cancelled', state: 'unknown' },
  { wire: 'error', outcome: 'failed', state: 'error' },
] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

for (const { wire, outcome, state } of cases) {
  test(`Moonraker print_stats printing -> ${wire} fills lastJob (${outcome})`, async () => {
    const controller = new AbortController()
    const agent = randomUUID()
    const refs = [
      { assignmentId: randomUUID(), agentId: agent, printerKey: 'fixture' },
    ]
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const rtc: CompleteFarmSnapshot[] = []
    let current: WireState = 'printing'
    let clock = 0
    let observed = 0
    let push: (delta: unknown) => void = () => {
      throw Error('Fixture not connected')
    }
    const fixture = await serveWsTestServer({
      http: () =>
        Response.json({
          result: { klippy_connected: true, klippy_state: 'ready' },
        }),
      upgrade: () => true,
      onMessage(socket, raw) {
        const request = JSON.parse(raw)
        if (request.method === 'server.connection.identify') {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { connection_id: 1 },
            }),
          )
          return
        }
        push = (delta) =>
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_status_update',
              params: [delta, ++clock],
            }),
          )
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              eventtime: ++clock,
              status: {
                webhooks: { state: 'ready' },
                print_stats: { state: current },
                virtual_sdcard: { progress: 0.5 },
              },
            },
          }),
        )
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
        observed++
      },
      onRawUnavailable: source.invalidate,
      signal: controller.signal,
      onEvent() {},
    })
    const timeout = setTimeout(() => controller.abort(), 8000)
    async function until(label: string, ready: () => boolean) {
      const deadline = Date.now() + 5000
      while (!ready()) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for ${label}`)
        await sleep(10)
      }
    }
    const latest = () => rtc.at(-1)?.printers[0]
    try {
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
      // The first complete query response is the first raw observation.
      await until('first observation', () => observed > 0)
      source.open({
        binding,
        assignmentRefs: refs,
        deadlineMonoMs: performance.now() + 6000,
        signal: controller.signal,
        onComplete(value) {
          rtc.push(value)
        },
        onUnavailable() {
          throw Error('RTC snapshot unavailable')
        },
      })

      // printing: no finished job yet.
      assert.equal(latest()?.state, 'printing')
      assert.equal(latest()?.lastJob, undefined)

      // printing -> terminal state
      current = wire
      push({ print_stats: { state: wire } })
      await until(`${wire} snapshot`, () => latest()?.state === state)
      const finished = latest()?.lastJob
      assert.equal(finished?.outcome, outcome)
      assert.equal(Number.isSafeInteger(finished?.endedAt), true)

      if (wire === 'cancelled') {
        const now = { wall: Date.now(), mono: performance.now() }
        const keys: FarmKeyState = {
          kind: 'available',
          choices: [{ keyId: 'k', thumbprint: 't' }],
          selected: 'k',
        }
        const row = {
          assignment: {
            ...refs[0],
            status: 'active',
            connectorStatus: 'approved',
          },
          connection: 'authenticated',
          localOrigin: null,
          observation: {
            state: {
              ...latest()!,
              controls: [
                'confirm_collection',
                'start_print',
                'set_tool_temperature',
              ],
            },
            received: now,
            sourceClockComparable: true,
            historical: false,
          },
        } as FarmRow
        assert.equal(
          controlActionAvailability('confirm_collection', row, keys, true, now)
            .available,
          true,
        )
        assert.equal(
          controlActionAvailability(
            'set_tool_temperature',
            row,
            keys,
            true,
            now,
          ).available,
          false,
        )
        assert.equal(liveReplayInfo(row, keys, true, now).state, 'cancelled')
        assert.equal(liveReplayInfo(row, keys, true, now).live, true)
        // Historical cancellation without current evidence remains read-only.
        const unknown = {
          ...row,
          observation: {
            ...row.observation!,
            state: { ...row.observation!.state, statusMessage: undefined },
          },
        }
        assert.equal(
          controlActionAvailability(
            'confirm_collection',
            unknown,
            keys,
            true,
            now,
          ).available,
          false,
        )
        assert.equal(
          controlActionAvailability(
            'set_tool_temperature',
            unknown,
            keys,
            true,
            now,
          ).available,
          false,
        )
        assert.equal(liveReplayInfo(unknown, keys, true, now).live, false)
        assert.equal(
          controlActionAvailability(
            'confirm_collection',
            { ...row, connection: 'closed' },
            keys,
            true,
            now,
          ).available,
          false,
        )
      }

      // The same terminal state re-observed keeps the first end time.
      await sleep(5)
      const count = rtc.length
      push({ virtual_sdcard: { progress: 0.75 } })
      await until('re-observation', () => rtc.length > count)
      assert.equal(latest()?.state, state)
      assert.deepEqual(latest()?.lastJob, finished)

      // A new print clears the previous result until it ends.
      current = 'printing'
      push({ print_stats: { state: 'printing' } })
      await until('next print', () => latest()?.state === 'printing')
      assert.equal(latest()?.lastJob, undefined)

      // The next print ending replaces it with a later end time.
      await sleep(5)
      current = 'complete'
      push({ print_stats: { state: 'complete' } })
      await until('second job', () => latest()?.state === 'idle')
      assert.equal(latest()?.lastJob?.outcome, 'completed')
      assert.ok((latest()?.lastJob?.endedAt ?? 0) > (finished?.endedAt ?? 0))
    } finally {
      clearTimeout(timeout)
      controller.abort()
      await subscription.done
      source.close()
      await fixture.stop()
    }
  })
}
