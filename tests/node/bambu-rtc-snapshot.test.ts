import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawMoonrakerObservation } from '../../packages/connector/src/moonraker/subscription.ts'
import {
  createFarmSnapshotSource,
  type RawPrinterObservation,
} from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import type { BambuTransportOptions } from '../../packages/connector/src/bambu/transport.ts'

function fixture(keys = ['a', 'b']) {
  const agent = randomUUID()
  const refs = keys.map((printerKey) => ({
    assignmentId: randomUUID(),
    agentId: agent,
    printerKey,
  }))
  let now = 100
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => now,
  })
  const received: CompleteFarmSnapshot[] = []
  let unavailable = 0
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
  const controller = new AbortController()
  function open(deadlineMonoMs = 10000) {
    return source.open({
      binding,
      deadlineMonoMs,
      assignmentRefs: refs,
      signal: controller.signal,
      onComplete(value) {
        received.push(value)
      },
      onUnavailable() {
        unavailable++
      },
    })
  }
  function observe(
    key: string,
    epoch = 1,
    times = { webhooks: now, printState: now, progress: now },
    temperatureObservation?: RawMoonrakerObservation['temperatureObservation'],
  ) {
    source.observe({
      printerKey: key,
      epoch,
      printer: {
        printerKey: key,
        state: 'printing',
        progress: 0.2,
        observedAt: 10,
      },
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'printing' },
        virtual_sdcard: { progress: 0.2 },
      },
      fieldObservedAtMonoMs: times,
      receivedAtMonoMs: now,
      ...(temperatureObservation ? { temperatureObservation } : {}),
    })
  }
  return {
    source,
    refs,
    received,
    open,
    observe,
    controller,
    binding,
    setNow(value: number) {
      now = value
    },
    unavailable: () => unavailable,
  }
}

function bambu(epoch = 1, state = 100, progress = 100): RawPrinterObservation {
  return {
    printerKey: 'bambu',
    epoch,
    printer: {
      printerKey: 'bambu',
      state: 'printing',
      progress: 0.2,
      observedAt: 10,
    },
    receivedAtMonoMs: Math.max(state, progress),
    fieldObservedAtMonoMs: { bambu: { state, progress } },
  }
}

test('fresh Bambu and Moonraker form a complete snapshot without borrowed freshness', () => {
  const f = fixture(['bambu', 'moonraker'])
  try {
    f.source.observe(bambu())
    f.observe('moonraker')
    f.open()
    assert.equal(f.received.length, 1)
    assert.deepEqual(
      f.received[0]?.printers.map((p) => [p.printerKey, p.state, p.progress]),
      [
        ['bambu', 'printing', 0.2],
        ['moonraker', 'printing', 0.2],
      ],
    )
    assert.equal(f.binding.commands_enabled, false)
    f.setNow(5000)
    f.source.observe(bambu(1, 100, 5000))
    f.observe('moonraker')
    assert.equal(f.received.at(-1)?.capturedAtMonoMs, 100)
    assert.equal(f.received.at(-1)?.validUntilMonoMs, 5100)
    f.setNow(5100)
    f.source.observe(bambu(1, 100, 5100))
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 3)
  } finally {
    f.source.close()
  }
})

test('Bambu invalidation retires its epoch and cannot borrow another printer evidence', () => {
  const f = fixture(['bambu', 'moonraker'])
  try {
    f.source.observe(bambu())
    f.observe('moonraker')
    f.open()
    f.source.invalidate({ printerKey: 'bambu', epoch: 1 })
    f.source.observe(bambu())
    f.observe('moonraker')
    f.open().close()
    assert.equal(f.received.length, 1)
    assert.equal(f.unavailable(), 2)
    f.source.observe(bambu(2))
    f.open().close()
    assert.equal(f.received.length, 2)
    f.source.invalidate({ printerKey: 'bambu', epoch: 1 })
    f.open().close()
    assert.equal(f.received.length, 3)
  } finally {
    f.source.close()
  }
})

test('malformed, missing, future and regressive Bambu field provenance fails closed', () => {
  for (const times of [
    {},
    { state: 100 },
    { state: NaN, progress: 100 },
    { state: -1, progress: 100 },
    { state: 301, progress: 100 },
    { state: 99, progress: 200 },
    { state: 100, progress: 99 },
    { state: 100, progress: 100, webhooks: 100 },
  ]) {
    const f = fixture(['bambu'])
    try {
      f.source.observe(bambu())
      f.open()
      f.setNow(300)
      assert.throws(
        () =>
          f.source.observe({
            ...bambu(),
            receivedAtMonoMs: 300,
            fieldObservedAtMonoMs: { bambu: times },
          }),
        /Invalid observation time/,
      )
      assert.equal(f.unavailable(), 1)
      assert.equal(f.received.length, 1)
      f.source.observe(bambu())
      f.open().close()
      assert.equal(f.received.length, 1)
    } finally {
      f.source.close()
    }
  }
})

test('collector forwards real Bambu runtime provenance to the snapshot provider and invalidates malformed reports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bambu-rtc-'))
  const credentialFile = join(directory, 'synthetic.json')
  writeFileSync(
    credentialFile,
    JSON.stringify({ accessCode: 'synthetic-only' }),
    { mode: 0o600 },
  )
  const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
  const controller = new AbortController()
  const f = fixture(['bambu'])
  let transport: BambuTransportOptions | undefined
  const observations: RawPrinterObservation[] = []
  const done = collectIntoQueue({
    config: parseLocalCollectorConfig({
      version: 3,
      allowedOrigins: [],
      printers: [],
      bambu: {
        printers: [
          {
            printerKey: 'bambu',
            serial: 'SYNTHETIC',
            host: '127.0.0.1',
            credentialFile,
            pinSha256: 'a'.repeat(64),
            allowedEndpoints: [{ host: '127.0.0.1', port: 8883 }],
          },
        ],
      },
    }),
    queue,
    signal: controller.signal,
    onDiagnostic() {},
    onRawObservation(value) {
      observations.push(value)
      f.setNow(performance.now())
      f.source.observe(value)
    },
    onRawUnavailable: f.source.invalidate,
    bambuTransport(options) {
      transport = options
      options.onConnection('connected')
      const done = new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      )
      return { done, close: async () => {} }
    },
  })
  try {
    // collectIntoQueue imports Moonraker before opening the Bambu subscription.
    for (let n = 0; !transport && n < 100; n++)
      await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(transport)
    transport.onReport(
      Buffer.from(
        JSON.stringify({ print: { gcode_state: 'RUNNING', mc_percent: 20 } }),
      ),
    )
    assert.equal(observations.length, 1)
    assert.equal(observations[0]?.status, undefined)
    f.open(performance.now() + 10000)
    assert.equal(f.received.length, 1)
    assert.equal(f.received[0]?.printers[0]?.progress, 0.2)
    assert.ok(
      observations[0] && 'bambu' in observations[0].fieldObservedAtMonoMs,
    )
    assert.equal(
      f.received[0]?.capturedAtMonoMs,
      observations[0].fieldObservedAtMonoMs.bambu.state,
    )
    transport.onReport(Buffer.from('{malformed'))
    assert.equal(f.unavailable(), 1)
    f.open().close()
    assert.equal(f.received.length, 1)
    transport.onReport(
      Buffer.from(
        JSON.stringify({ print: { gcode_state: 'RUNNING', mc_percent: 30 } }),
      ),
    )
    f.open(performance.now() + 10000).close()
    assert.equal(f.received.length, 2)
    assert.equal(f.received.at(-1)?.printers[0]?.progress, 0.3)
  } finally {
    controller.abort()
    await done
    f.source.close()
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Bambu temperature stamps remain immutable and expiry fails closed without new reports', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(['bambu'])
  const stamps = { state: 100, progress: 100, toolTemperatureCelsius: 50 }
  try {
    f.source.observe({
      ...bambu(),
      printer: { ...bambu().printer, toolTemperatureCelsius: 0 },
      fieldObservedAtMonoMs: { bambu: stamps },
    })
    f.open()
    assert.equal(f.received[0]?.printers[0]?.toolTemperatureCelsius, 0)
    assert.equal(f.received[0]?.capturedAtMonoMs, 50)
    assert.equal(f.received[0]?.validUntilMonoMs, 5050)
    stamps.toolTemperatureCelsius = 100
    f.setNow(5050)
    t.mock.timers.tick(4950)
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 1)
    f.open().close()
    assert.equal(f.unavailable(), 2)
    assert.equal(f.received.length, 1)
  } finally {
    f.source.close()
    t.mock.timers.reset()
  }
})

test('identical fresh Moonraker telemetry continues to produce a complete snapshot', () => {
  const f = fixture(['moonraker'])
  try {
    f.observe('moonraker')
    f.open()
    assert.equal(f.unavailable(), 0)
    assert.equal(f.received.length, 1)
    assert.deepEqual(f.received[0]?.printers, [
      {
        printerKey: 'moonraker',
        state: 'printing',
        progress: 0.2,
        observedAt: 10,
      },
    ])
    assert.equal(f.received[0]?.capturedAtMonoMs, 100)
    assert.equal(f.received[0]?.validUntilMonoMs, 5100)
  } finally {
    f.source.close()
  }
})
