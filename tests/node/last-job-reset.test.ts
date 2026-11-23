import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import {
  startAnycubicSimulator,
  packet,
} from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/index.ts'
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

type WireState =
  'standby' | 'printing' | 'paused' | 'error' | 'complete' | 'cancelled'

const cases = [
  { wire: 'complete', outcome: 'completed', state: 'idle' },
  { wire: 'cancelled', outcome: 'cancelled', state: 'idle' },
  { wire: 'error', outcome: 'failed', state: 'error' },
] as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

for (const { wire, outcome, state } of cases) {
  test(`Moonraker reset on paused job after ${wire} fills lastJob (${outcome})`, async () => {
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

      // The same terminal state re-observed keeps the first end time.
      await sleep(5)
      const count = rtc.length
      push({ virtual_sdcard: { progress: 0.75 } })
      await until('re-observation', () => rtc.length > count)
      assert.equal(latest()?.state, state)
      assert.deepEqual(latest()?.lastJob, finished)

      // A new print clears the previous result until it ends.
      current = 'paused'
      push({ print_stats: { state: 'paused' } })
      await until('next paused job', () => latest()?.state === 'paused')
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

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await delay(10)
  }
  throw Error('Timed out waiting for snapshot')
}

test('Anycubic resets lastJob at each new simulator job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anycubic-job-'))
  const passwordFile = join(dir, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('password'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    serial: '20024/TEST',
    printDurationMs: 500,
  })
  const controller = new AbortController()
  const agent = randomUUID()
  const refs = [
    { assignmentId: randomUUID(), agentId: agent, printerKey: 'fixture' },
  ]
  const source = createFarmSnapshotSource({ assignmentRefs: refs })
  const snapshots: CompleteFarmSnapshot[] = []
  let observations = 0
  const collector = createAnycubicCollection({
    binding: {
      printerKey: 'fixture',
      host: sim.host,
      port: sim.port,
      modelId: '20024',
      deviceId: 'TEST',
      username: 'user',
      passwordFile,
    },
    signal: controller.signal,
    transport: (options) =>
      createAnycubicLanClient({ ...options, caPem: sim.syntheticTrust }),
    onObservation(value) {
      source.observe(value)
      observations++
    },
    onUnavailable(epoch) {
      source.invalidate({ printerKey: 'fixture', epoch })
    },
  })
  const socket = connect({
    host: sim.host,
    port: sim.port,
    ca: sim.syntheticTrust,
  })
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
  const latest = () => snapshots.at(-1)?.printers[0]
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      packet(16, Buffer.from('00044d51545404020000000474657374', 'hex')),
    )
    await new Promise<void>((resolve) => socket.once('data', () => resolve()))
    const publish = (topic: string, value: unknown) => {
      const name = Buffer.from(topic),
        length = Buffer.alloc(2)
      length.writeUInt16BE(name.length)
      socket.write(
        packet(
          48,
          Buffer.concat([length, name, Buffer.from(JSON.stringify(value))]),
        ),
      )
    }
    const start = () =>
      publish(
        'anycubic/anycubicCloud/v1/slicer/printer/20024/20024/TEST/print',
        {
          type: 'print',
          action: 'start',
          data: { filename: 'part.gcode' },
        },
      )
    sim.upload('part.gcode', Buffer.from('G28\n'))
    await until(() => {
      sim.publishReport({ data: { state: 'idle', progress: 0 } })
      return observations > 0
    })
    source.open({
      binding,
      assignmentRefs: refs,
      deadlineMonoMs: performance.now() + 10000,
      signal: controller.signal,
      onComplete(value) {
        snapshots.push(value)
      },
      onUnavailable() {},
    })
    for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
      start()
      await until(() => latest()?.state === 'printing')
      assert.equal(latest()?.lastJob, undefined)
      if (outcome === 'cancelled')
        publish(
          'anycubic/anycubicCloud/v1/printer/public/20024/TEST/print/request',
          { type: 'print', action: 'stop' },
        )
      if (outcome === 'failed') sim.failPrint()
      await until(() => latest()?.lastJob?.outcome === outcome)
      const finished = latest()?.lastJob
      assert.ok(Number.isSafeInteger(finished?.endedAt))
      await delay(120)
      assert.deepEqual(latest()?.lastJob, finished)
    }
  } finally {
    controller.abort()
    socket.destroy()
    await collector.done
    source.close()
    await sim.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
