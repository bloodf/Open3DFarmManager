import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { SpoolmanSnapshot } from '../../packages/connector/src/runtime/spoolman-provider.ts'
import type { RawMoonrakerObservation } from '../../packages/connector/src/moonraker/subscription.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'

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
    setNow(value: number) {
      now = value
    },
    unavailable: () => unavailable,
  }
}
test('complete immutable configured set; unchanged full observation refreshes raw evidence', () => {
  const f = fixture()
  try {
    f.observe('a')
    f.observe('b')
    const h = f.open()
    assert.equal(f.received.length, 1)
    assert.equal(f.received[0]?.validUntilMonoMs, 5100)
    f.setNow(1100)
    f.observe('a')
    f.observe('b')
    assert.equal(f.received.at(-1)?.validUntilMonoMs, 6100)
    assert.equal(Object.isFrozen(f.received.at(-1)?.printers[0]), true)
    h.close()
    f.observe('a')
    assert.equal(f.received.length, 3)
  } finally {
    f.source.close()
  }
})
test('progress alone never refreshes other fields and stale complete set is terminal', () => {
  const f = fixture(['a'])
  try {
    f.observe('a')
    f.open()
    f.setNow(5000)
    f.observe('a', 1, { webhooks: 100, printState: 100, progress: 5000 })
    assert.equal(f.received.at(-1)?.validUntilMonoMs, 5100)
    f.setNow(5100)
    f.observe('a', 1, { webhooks: 100, printState: 100, progress: 5100 })
    assert.equal(f.unavailable(), 1)
    f.setNow(5200)
    f.observe('a')
    assert.equal(f.received.length, 2)
  } finally {
    f.source.close()
  }
})
test('invalidation retires epoch, cannot revive closed provider, next epoch requires new provider', () => {
  const f = fixture(['a'])
  try {
    f.observe('a')
    f.open()
    f.source.invalidate({ printerKey: 'a', epoch: 1 })
    f.observe('a')
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 1)
    const denied = f.open()
    assert.equal(f.unavailable(), 2)
    denied.close()
    f.observe('a', 2)
    f.open()
    assert.equal(f.received.length, 2)
    f.source.invalidate({ printerKey: 'a', epoch: 1 })
    assert.equal(f.unavailable(), 2)
  } finally {
    f.source.close()
  }
})
test('missing member, oversized escaped UTF8 set, and clock regression fail closed', () => {
  const f = fixture()
  try {
    f.observe('a')
    f.open()
    assert.equal(f.unavailable(), 1)
  } finally {
    f.source.close()
  }
  const large = fixture(
    Array.from({ length: 16 }, (_, i) => `${i}${'界'.repeat(120)}`),
  )
  try {
    for (const ref of large.refs) large.observe(ref.printerKey)
    large.open()
    assert.equal(large.unavailable(), 1)
    assert.equal(large.received.length, 0)
  } finally {
    large.source.close()
  }
  const regressed = fixture(['a'])
  try {
    regressed.observe('a')
    regressed.open()
    regressed.setNow(99)
    assert.throws(() => regressed.observe('a'), /clock/)
    assert.equal(regressed.unavailable(), 1)
  } finally {
    regressed.source.close()
  }
})
test('abort closes provider without unavailable callback or future publications', () => {
  const f = fixture(['a'])
  try {
    f.observe('a')
    f.open()
    f.controller.abort()
    f.setNow(200)
    f.observe('a')
    assert.equal(f.received.length, 1)
    assert.equal(f.unavailable(), 0)
  } finally {
    f.source.close()
  }
})

test('each field rejects its own timestamp regression even when another field is older', () => {
  const f = fixture(['a'])
  try {
    f.setNow(300)
    f.observe('a', 1, { webhooks: 100, printState: 200, progress: 300 })
    f.open()
    f.setNow(400)
    assert.throws(
      () =>
        f.observe('a', 1, { webhooks: 100, printState: 200, progress: 250 }),
      /Invalid observation time/,
    )
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 1)
    f.observe('a')
    assert.equal(f.received.length, 1)
  } finally {
    f.source.close()
  }
})

test('provider validity is capped by original verified monotonic admission deadline', () => {
  const f = fixture(['a'])
  try {
    f.observe('a')
    f.open(300)
    assert.equal(f.received[0]?.validUntilMonoMs, 300)
    f.setNow(300)
    f.observe('a')
    assert.equal(f.unavailable(), 1)
    f.setNow(400)
    f.observe('a')
    assert.equal(f.received.length, 1)
  } finally {
    f.source.close()
  }
})

test('expiry timer retires complete source without another update', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(['a'])
  try {
    f.observe('a')
    f.open()
    f.setNow(5100)
    t.mock.timers.tick(5000)
    assert.equal(f.unavailable(), 1)
    f.setNow(5200)
    f.observe('a')
    assert.equal(f.received.length, 1)
  } finally {
    f.source.close()
    t.mock.timers.reset()
  }
})

test('complete temperature evidence projects zero and negative values and core deltas never rejuvenate it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(['a'])
  const temperature: NonNullable<
    RawMoonrakerObservation['temperatureObservation']
  > = {
    fields: {
      tool: { kind: 'reading', celsius: 0 },
      bed: { kind: 'reading', celsius: -10.5 },
    },
    observedAtMonoMs: 100,
  }
  try {
    f.observe('a', 1, undefined, temperature)
    f.open()
    assert.deepEqual(f.received[0]?.printers, [
      {
        printerKey: 'a',
        state: 'printing',
        progress: 0.2,
        observedAt: 10,
        toolTemperatureCelsius: 0,
        bedTemperatureCelsius: -10.5,
      },
    ])
    temperature.fields.tool = { kind: 'reading', celsius: 99 }
    f.setNow(4100)
    f.observe('a')
    assert.equal(f.received.at(-1)?.printers[0]?.toolTemperatureCelsius, 0)
    assert.equal(f.received.at(-1)?.capturedAtMonoMs, 100)
    assert.equal(f.received.at(-1)?.validUntilMonoMs, 5100)
    f.setNow(5100)
    t.mock.timers.tick(5000)
    assert.equal(f.unavailable(), 1)
    assert.equal(f.received.length, 2)
  } finally {
    f.source.close()
    t.mock.timers.reset()
  }
})

test('complete invalid/absent evidence clears readings; new epoch cannot borrow a retired reading', () => {
  const f = fixture(['a'])
  try {
    f.observe('a', 1, undefined, {
      fields: {
        tool: { kind: 'reading', celsius: 200 },
        bed: { kind: 'absent' },
      },
      observedAtMonoMs: 100,
    })
    f.open()
    f.setNow(200)
    f.observe('a', 1, undefined, {
      fields: { tool: { kind: 'invalid' }, bed: { kind: 'absent' } },
      observedAtMonoMs: 200,
    })
    assert.deepEqual(f.received.at(-1)?.printers, [
      { printerKey: 'a', state: 'printing', progress: 0.2, observedAt: 10 },
    ])
    f.setNow(300)
    f.observe('a', 1, undefined, {
      fields: {
        tool: { kind: 'absent' },
        bed: { kind: 'reading', celsius: 60 },
      },
      observedAtMonoMs: 300,
    })
    assert.equal(f.received.at(-1)?.printers[0]?.bedTemperatureCelsius, 60)
    f.source.invalidate({ printerKey: 'a', epoch: 1 })
    f.setNow(400)
    f.observe('a', 2)
    const handle = f.open()
    assert.deepEqual(f.received.at(-1)?.printers, [
      { printerKey: 'a', state: 'printing', progress: 0.2, observedAt: 10 },
    ])
    handle.close()
  } finally {
    f.source.close()
  }
})

test('future/regressive temperature stamps invalidate evidence without publishing a fabricated value', () => {
  for (const bad of [-1, NaN, 301, 99]) {
    const f = fixture(['a'])
    try {
      f.observe('a', 1, undefined, {
        fields: {
          tool: { kind: 'reading', celsius: 0 },
          bed: { kind: 'absent' },
        },
        observedAtMonoMs: 100,
      })
      f.open()
      f.setNow(300)
      assert.throws(
        () =>
          f.observe('a', 1, undefined, {
            fields: {
              tool: { kind: 'reading', celsius: 999 },
              bed: { kind: 'absent' },
            },
            observedAtMonoMs: bad,
          }),
        /Invalid temperature observation time/,
      )
      assert.equal(f.unavailable(), 1)
      assert.equal(f.received.length, 1)
    } finally {
      f.source.close()
    }
  }
})

function spoolman(
  count: number,
  kind: SpoolmanSnapshot['kind'] = 'observed',
  ageMs = 1000,
): SpoolmanSnapshot {
  const filament = (n: number) => ({
    id: n,
    name: `Filamento ${n} ${'x'.repeat(100)}`,
    material: 'PETG-CF-EXTRA-LONG-MATERIAL',
    vendor: null,
    density: null,
    diameter: null,
    weight: null,
    spool_weight: null,
    color_hex: 'AABBCCDD',
    extra: {},
  })
  return {
    kind,
    ageMs,
    inventory: {
      farmId: randomUUID(),
      serviceId: randomUUID(),
      observedFrom: 1,
      observedThrough: 1,
      items: Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        filament: filament(i + 1),
        initial_weight: 1000,
        spool_weight: 200,
        used_weight: 100,
        remaining_weight: i === 1 ? -4.4 : 900.6,
        location: i === 2 ? null : 'Prateleira A',
        lot_nr: null,
        // First spool is archived; active ones must sort ahead of it.
        archived: i === 0,
        extra: {},
      })),
    },
  } as unknown as SpoolmanSnapshot
}
test('spool mirror rides on snapshots: bounded, sorted, stale-aware and omitted when unavailable', () => {
  const f = fixture(['a'])
  const wall = Date.now()
  try {
    f.observe('a')
    f.open(100_000)
    assert.equal(f.received.at(-1)?.inventory, undefined)
    f.source.setInventory(spoolman(20))
    const inv = f.received.at(-1)?.inventory
    assert.ok(inv)
    assert.equal(inv.total, 20)
    assert.ok(inv.spools.length <= 8)
    assert.equal(inv.stale, false)
    assert.ok(Math.abs(inv.observedAt - (wall - 1000)) < 5000)
    // Active spools first; archived one sorts last.
    assert.equal(inv.spools[0]?.archived, false)
    assert.equal(
      inv.spools.some((s) => s.archived),
      false,
    )
    assert.equal(inv.spools[0]?.remainingGrams, -4)
    assert.equal(inv.spools[1]?.location, null)
    assert.equal(inv.spools[0]?.colorHex, 'aabbcc')
    assert.ok((inv.spools[0]?.name?.length ?? 99) <= 32)
    assert.equal(Object.isFrozen(inv), true)
    assert.equal(Object.isFrozen(inv.spools[0]), true)
    // Whole frame still fits the 2048-byte application cap.
    assert.ok(
      new TextEncoder().encode(
        JSON.stringify({
          t: 'snapshot',
          seq: 1024,
          printers: f.received.at(-1)?.printers,
          inventory: inv,
        }),
      ).byteLength <= 2048,
    )
    // Monotonic age advances; 30 s makes it stale without a provider update.
    f.setNow(31_200)
    f.observe('a', 1, {
      webhooks: 31_200,
      printState: 31_200,
      progress: 31_200,
    })
    assert.equal(f.received.at(-1)?.inventory?.stale, true)
    f.source.setInventory(spoolman(2, 'stale'))
    assert.equal(f.received.at(-1)?.inventory?.stale, true)
    f.source.setInventory({ kind: 'unavailable', inventory: null, ageMs: null })
    assert.equal(f.received.at(-1)?.inventory, undefined)
  } finally {
    f.source.close()
  }
})
