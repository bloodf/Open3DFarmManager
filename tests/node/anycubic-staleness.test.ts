import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'

test('partial reports keep Anycubic available after once-only fields expire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const directory = mkdtempSync(join(tmpdir(), 'anycubic-staleness-'))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let report: (payload: unknown) => void = () => {}
  const observations: Parameters<
    Parameters<typeof createAnycubicCollection>[0]['onObservation']
  >[0][] = []
  const unavailable: number[] = []
  const agentId = randomUUID()
  const refs = [{ assignmentId: randomUUID(), agentId, printerKey: 'a' }]
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => now,
  })
  const received: CompleteFarmSnapshot[] = []
  let closed = 0
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: agentId,
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
  const collection = createAnycubicCollection({
    binding: {
      printerKey: 'a',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'test',
      passwordFile,
    },
    signal: controller.signal,
    onObservation: (value) => {
      observations.push(value)
      source.observe(value)
    },
    onUnavailable: (epoch) => {
      unavailable.push(epoch)
      source.invalidate({ printerKey: 'a', epoch })
    },
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  try {
    report({
      data: {
        state: 'printing',
        progress: 10,
        filename: 'part.gcode',
        total_layers: 100,
        project: { remain_time: 18 },
      },
    })
    const session = source.open({
      binding,
      assignmentRefs: refs,
      signal: controller.signal,
      deadlineMonoMs: 20000,
      onComplete: (value) => {
        received.push(value)
      },
      onUnavailable: () => {
        closed++
      },
    })
    for (let i = 1; i <= 8; i++) {
      now += 1000
      t.mock.timers.tick(1000)
      if (i === 5) {
        assert.equal(closed, 0)
        assert.equal(received.at(-1)?.printers[0]?.filename, undefined)
        assert.equal(received.at(-1)?.printers[0]?.totalLayer, undefined)
        assert.equal(
          received.at(-1)?.printers[0]?.estimatedRemainingSeconds,
          undefined,
        )
      }
      report({ data: { state: 'printing', progress: 10 + i } })
      const latest = observations.at(-1)
      assert.equal(
        latest?.printer.estimatedRemainingSeconds,
        i < 5 ? 1080 : undefined,
      )
      const timing = latest?.fieldObservedAtMonoMs
      assert.ok(timing && 'anycubic' in timing)
      assert.equal(
        timing.anycubic.estimatedRemainingSeconds,
        i < 5 ? 100 : undefined,
      )
    }
    assert.equal(observations.length, 9)
    assert.deepEqual(unavailable, [])
    now += 5000
    t.mock.timers.tick(5000)
    assert.deepEqual(unavailable, [1])
    assert.equal(closed, 1)
    session.close()

    // Exercise provider deadlines independently of the collector's own timer.
    now = 10000
    const independent = createFarmSnapshotSource({
      assignmentRefs: refs,
      nowMono: () => now,
    })
    const updates: CompleteFarmSnapshot[] = []
    let providerClosed = 0
    independent.observe({
      printerKey: 'a',
      epoch: 1,
      receivedAtMonoMs: now,
      printer: {
        printerKey: 'a',
        state: 'printing',
        progress: 0.5,
        filename: 'part.gcode',
        totalLayer: 100,
        estimatedRemainingSeconds: 1080,
        observedAt: 1,
      },
      fieldObservedAtMonoMs: {
        anycubic: {
          state: 9000,
          progress: 9500,
          filename: 6000,
          totalLayer: 7000,
          estimatedRemainingSeconds: 8000,
        },
      },
    })
    const separateSession = independent.open({
      binding,
      assignmentRefs: refs,
      signal: controller.signal,
      deadlineMonoMs: 20000,
      onComplete: (value) => {
        updates.push(value)
      },
      onUnavailable: () => {
        providerClosed++
      },
    })
    assert.equal(updates.at(-1)?.validUntilMonoMs, 14000)
    for (const [field, target] of [
      ['filename', 11000],
      ['totalLayer', 12000],
      ['estimatedRemainingSeconds', 13000],
    ] as const) {
      now = target
      const count = updates.length
      t.mock.timers.tick(1000)
      assert.equal(updates.length, count + 1)
      assert.equal(updates.at(-1)?.printers[0]?.[field], undefined)
      assert.equal(updates.at(-1)?.validUntilMonoMs, 14000)
      assert.equal(providerClosed, 0)
    }
    now = 14000
    t.mock.timers.tick(1000)
    assert.equal(providerClosed, 1)
    separateSession.close()
    independent.close()
  } finally {
    controller.abort()
    await collection.done
    rmSync(directory, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('recognized state without progress waits without retiring epochs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anycubic-pending-'))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let report: (payload: unknown) => void = () => {}
  const unavailable: number[] = []
  const observations: Parameters<
    Parameters<typeof createAnycubicCollection>[0]['onObservation']
  >[0][] = []
  const collection = createAnycubicCollection({
    binding: {
      printerKey: 'a',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'test',
      passwordFile,
    },
    signal: controller.signal,
    onObservation: (value) => observations.push(value),
    onUnavailable: (epoch) => unavailable.push(epoch),
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  try {
    for (let i = 0; i < 3; i++)
      report({ data: { state: 'free', project: null } })
    assert.deepEqual(unavailable, [])
    assert.equal(observations.length, 0)
    report({ data: { progress: 0 } })
    assert.equal(observations.at(-1)?.printer.state, 'idle')
    assert.equal(observations.at(-1)?.epoch, 1)
  } finally {
    controller.abort()
    await collection.done
    rmSync(directory, { recursive: true, force: true })
  }
})

test('first filename preserves a fresh estimate; a different known filename clears it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anycubic-filename-'))
  const passwordFile = join(directory, 'password.json')
  writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const controller = new AbortController()
  let report: (payload: unknown) => void = () => {}
  const observations: Parameters<
    Parameters<typeof createAnycubicCollection>[0]['onObservation']
  >[0][] = []
  const collection = createAnycubicCollection({
    binding: {
      printerKey: 'a',
      host: '127.0.0.1',
      port: 9883,
      modelId: '20024',
      deviceId: 'SYNTHETIC',
      username: 'test',
      passwordFile,
    },
    signal: controller.signal,
    onObservation: (value) => observations.push(value),
    onUnavailable: () => {},
    transport(options) {
      report = (payload) =>
        options.onReport(Buffer.from(JSON.stringify(payload)))
      return { done: Promise.resolve(), close: async () => {} }
    },
  })
  try {
    report({
      data: { state: 'printing', progress: 10, project: { remain_time: 18 } },
    })
    assert.equal(observations.at(-1)?.printer.estimatedRemainingSeconds, 1080)
    report({ data: { filename: 'first.gcode' } })
    assert.equal(observations.at(-1)?.printer.filename, 'first.gcode')
    assert.equal(observations.at(-1)?.printer.estimatedRemainingSeconds, 1080)
    report({ data: { filename: 'first.gcode' } })
    assert.equal(observations.at(-1)?.printer.filename, 'first.gcode')
    assert.equal(observations.at(-1)?.printer.estimatedRemainingSeconds, 1080)
    report({ data: { filename: 'second.gcode' } })
    assert.equal(observations.at(-1)?.printer.filename, 'second.gcode')
    assert.equal(
      observations.at(-1)?.printer.estimatedRemainingSeconds,
      undefined,
    )
  } finally {
    controller.abort()
    await collection.done
    rmSync(directory, { recursive: true, force: true })
  }
})
