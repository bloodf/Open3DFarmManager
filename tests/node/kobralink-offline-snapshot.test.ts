import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import {
  createFarmSnapshotSource,
  type RawPrinterObservation,
} from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'

function fixture(keys = ['kobra']) {
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
  const snapshots: CompleteFarmSnapshot[] = []
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
  function offline(epoch = 1, printerKey = 'kobra'): RawPrinterObservation {
    return {
      printerKey,
      epoch,
      printer: { printerKey, state: 'offline', observedAt: 1700000000000 },
      fieldObservedAtMonoMs: { connection: now },
      receivedAtMonoMs: now,
    }
  }
  function open(assignmentRefs = refs) {
    return source.open({
      binding,
      assignmentRefs,
      deadlineMonoMs: 10000,
      signal: new AbortController().signal,
      onComplete(value) {
        snapshots.push(value)
      },
      onUnavailable() {
        unavailable++
      },
    })
  }
  return {
    source,
    snapshots,
    refs,
    offline,
    open,
    unavailable: () => unavailable,
    setNow(value: number) {
      now = value
    },
  }
}

test('only offline may omit progress; online zero remains valid', () => {
  for (const state of ['idle', 'printing', 'paused', 'error', 'offline']) {
    const value = { printerKey: 'kobra', state, observedAt: 1 }
    assert.equal(PrinterState.safeParse(value).success, state === 'offline')
    assert.equal(
      PrinterState.safeParse({ ...value, progress: 0 }).success,
      true,
    )
    for (const progress of [null, -1, 2, '0'])
      assert.equal(
        PrinterState.safeParse({ ...value, progress }).success,
        false,
      )
  }
})

test('offline discards retained temperatures and cannot retain them on recovery', () => {
  const f = fixture()
  try {
    f.source.observe({
      ...f.offline(),
      printer: {
        printerKey: 'kobra',
        state: 'printing',
        progress: 0.5,
        observedAt: 1,
      },
      fieldObservedAtMonoMs: { webhooks: 100, printState: 100, progress: 100 },
      temperatureObservation: {
        observedAtMonoMs: 100,
        fields: {
          tool: { kind: 'reading', celsius: 200 },
          bed: { kind: 'reading', celsius: 60 },
        },
      },
    })
    f.open()
    assert.equal(f.snapshots.at(-1)?.printers[0]?.toolTemperatureCelsius, 200)
    f.setNow(200)
    f.source.observe(f.offline())
    assert.deepEqual(f.snapshots.at(-1)?.printers[0], f.offline().printer)
    f.setNow(300)
    f.source.observe({
      ...f.offline(),
      printer: {
        printerKey: 'kobra',
        state: 'printing',
        progress: 0.6,
        observedAt: 2,
      },
      fieldObservedAtMonoMs: { webhooks: 300, printState: 300, progress: 300 },
    })
    assert.equal(
      f.snapshots.at(-1)?.printers[0]?.toolTemperatureCelsius,
      undefined,
    )
    assert.equal(f.unavailable(), 0)
  } finally {
    f.source.close()
  }
})

test('offline preserves full-set requirement and exact assignment identity', () => {
  const f = fixture(['kobra', 'moon'])
  try {
    f.source.observe(f.offline())
    f.open()
    assert.equal(f.snapshots.length, 0)
    assert.equal(f.unavailable(), 1)
    f.source.observe(f.offline(1, 'moon'))
    const handle = f.open()
    assert.equal(f.snapshots.at(-1)?.printers.length, 2)
    handle.close()
    assert.throws(
      () =>
        f.open(f.refs.map((ref) => ({ ...ref, assignmentId: randomUUID() }))),
      /Exact configured scope/,
    )
  } finally {
    f.source.close()
  }
})

test('retired epochs cannot be revived by offline responses', () => {
  const f = fixture()
  try {
    f.source.observe(f.offline())
    f.open()
    f.source.invalidate({ printerKey: 'kobra', epoch: 1 })
    f.source.observe(f.offline())
    f.open()
    assert.equal(f.snapshots.length, 1)
    assert.equal(f.unavailable(), 2)
    f.source.observe(f.offline(2))
    f.open()
    assert.equal(f.snapshots.length, 2)
  } finally {
    f.source.close()
  }
})

test('offline connection time cannot move backwards or refresh expired data', () => {
  const f = fixture()
  try {
    f.source.observe(f.offline())
    f.open()
    f.setNow(5100)
    f.source.observe({
      ...f.offline(),
      fieldObservedAtMonoMs: { connection: 100 },
    })
    assert.equal(f.unavailable(), 1)
    assert.equal(f.snapshots.length, 1)
    assert.throws(
      () =>
        f.source.observe({
          ...f.offline(),
          fieldObservedAtMonoMs: { connection: 99 },
        }),
      /Invalid observation time/,
    )
  } finally {
    f.source.close()
  }
})
