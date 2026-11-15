import { startAnycubicSimulator } from '../../packages/sim-tools/src/anycubic-simulator.ts'
import { createAnycubicLanClient } from '../../packages/connector/src/anycubic/index.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFarmSnapshotSource,
  type RawPrinterObservation,
} from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import { createCrealityCollection } from '../../packages/connector/src/runtime/creality-collection.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { getSpoolmanMaterials } from '../../packages/connector/src/runtime/spoolman-materials.ts'
import { SpoolmanSpool } from '../../packages/connector/src/spoolman/read.ts'
function fixture(
  keys = ['a', 'b'],
  controlsFor?: Parameters<typeof createFarmSnapshotSource>[0]['controlsFor'],
) {
  const agent = randomUUID()
  const refs = keys.map((printerKey) => ({
    assignmentId: randomUUID(),
    agentId: agent,
    printerKey,
  }))
  let now = 100
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    ...(controlsFor === undefined ? {} : { controlsFor }),
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
  return {
    source,
    refs,
    received,
    open,
    controller,
    binding,
    setNow(value: number) {
      now = value
    },
    unavailable: () => unavailable,
  }
}

for (const vendor of ['creality', 'anycubic', 'bambu'] as const) {
  test(`${vendor} environment fields expire individually without losing state`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture(['a'])
    try {
      f.source.observe({
        printerKey: 'a',
        epoch: 1,
        receivedAtMonoMs: 100,
        printer: {
          printerKey: 'a',
          state: 'idle',
          progress: 0,
          observedAt: 1,
          fans: { part: 0 },
          light: { chamber: false },
          materials: [{ slot: 'external', materialType: 'PLA' }],
        },
        fieldObservedAtMonoMs: {
          [vendor]: {
            state: 100,
            progress: 100,
            fans: 0,
            light: 50,
            materials: 75,
          },
        } as RawPrinterObservation['fieldObservedAtMonoMs'],
      })
      f.open()
      assert.deepEqual(f.received.at(-1)?.printers[0]?.fans, { part: 0 })
      for (const [now, field] of [
        [5000, 'fans'],
        [5050, 'light'],
        [5075, 'materials'],
      ] as const) {
        f.setNow(now)
        t.mock.timers.tick(now === 5000 ? 4900 : now === 5050 ? 50 : 25)
        assert.equal(f.received.at(-1)?.printers[0]?.[field], undefined)
        assert.equal(f.received.at(-1)?.printers[0]?.state, 'idle')
        assert.equal(f.unavailable(), 0)
      }
    } finally {
      f.source.close()
      t.mock.timers.reset()
    }
  })
}

test(
  'Creality simulator merges separate CFS and environment frames without refreshing state',
  { timeout: 10000 },
  async () => {
    const simulator = await createCrealitySimulator({
      state: 1,
      printProgress: 42,
    })
    const controller = new AbortController()
    const f = fixture(['a'])
    let notify: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      notify = resolve
    })
    const observations: RawPrinterObservation[] = []
    const collection = createCrealityCollection({
      binding: { printerKey: 'a', host: '127.0.0.1', port: simulator.port },
      signal: controller.signal,
      onObservation(value) {
        observations.push(value)
        f.setNow(performance.now())
        f.source.observe(value)
        notify?.()
      },
      onUnavailable(epoch) {
        f.source.invalidate({ printerKey: 'a', epoch })
      },
    })
    try {
      await first
      f.open(performance.now() + 9000)
      const next = new Promise<void>((resolve) => {
        notify = resolve
      })
      simulator.emitFrame({
        modelFanPct: 23,
        lightSw: 0,
        boxsInfo: {
          materialBoxs: [
            {
              id: 0,
              materials: [{ id: 1, type: 'PLA', percent: 25, selected: 1 }],
            },
          ],
        },
      })
      await next
      assert.deepEqual(f.received.at(-1)?.printers[0]?.fans, { part: 23 })
      assert.deepEqual(f.received.at(-1)?.printers[0]?.light, {
        chamber: false,
      })
      assert.deepEqual(f.received.at(-1)?.printers[0]?.materials, [
        {
          slot: '0:1',
          materialType: 'PLA',
          remainingPercent: 25,
          active: true,
        },
      ])
      const times = observations.map((value) =>
        'creality' in value.fieldObservedAtMonoMs
          ? value.fieldObservedAtMonoMs.creality
          : {},
      )
      assert.equal(times[0]?.state, times[1]?.state)
      assert.ok(times[1]!.materials! >= times[1]!.state!)
      assert.deepEqual(simulator.received, [])
    } finally {
      controller.abort()
      await collection.done
      f.source.close()
      await simulator.close()
    }
  },
)

test('Spoolman active material reaches Moonraker snapshot and expires alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(['a'])
  const spool = SpoolmanSpool.parse({
    id: 3,
    filament: { id: 1, material: 'PLA', color_hex: 'aabbcc' },
    initial_weight: 1000,
    remaining_weight: 250,
    archived: false,
  })
  const inventory = {
    kind: 'observed' as const,
    ageMs: 0,
    inventory: {
      items: [spool],
      farmId: 'a',
      serviceId: 'b',
      observedFrom: 0,
      observedThrough: 0,
    },
  }
  try {
    const materials = await getSpoolmanMaterials(async () => 3, inventory)
    assert.ok(materials)
    f.source.observe({
      printerKey: 'a',
      epoch: 1,
      printer: { printerKey: 'a', state: 'idle', progress: 0, observedAt: 1 },
      receivedAtMonoMs: 100,
      fieldObservedAtMonoMs: { webhooks: 100, printState: 100, progress: 100 },
      materialsObservation: { materials, observedAtMonoMs: 0 },
    })
    f.open()
    assert.deepEqual(f.received.at(-1)?.printers[0]?.materials, [
      {
        slot: 'external',
        active: true,
        materialType: 'PLA',
        colorHex: 'AABBCCFF',
        remainingPercent: 25,
      },
    ])
    f.setNow(5000)
    t.mock.timers.tick(4900)
    assert.equal(f.received.at(-1)?.printers[0]?.materials, undefined)
    assert.equal(f.unavailable(), 0)
    assert.equal(
      await getSpoolmanMaterials(async () => 3, {
        ...inventory,
        kind: 'stale',
      }),
      undefined,
    )
  } finally {
    f.source.close()
    t.mock.timers.reset()
  }
})

test(
  'Anycubic TLS simulator sends environmental telemetry to the RTC source',
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'env-anycubic-'))
    const passwordFile = join(directory, 'password.json')
    writeFileSync(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
    const simulator = await startAnycubicSimulator({
      serial: '20024/SYNTHETIC',
    })
    const controller = new AbortController()
    const f = fixture(['a'])
    let resolve!: () => void
    const observed = new Promise<void>((done) => {
      resolve = done
    })
    const collection = createAnycubicCollection({
      binding: {
        printerKey: 'a',
        host: '127.0.0.1',
        port: simulator.port,
        modelId: '20024',
        deviceId: 'SYNTHETIC',
        username: 'synthetic',
        passwordFile,
      },
      signal: controller.signal,
      transport: (options) =>
        createAnycubicLanClient({
          ...options,
          caPem: simulator.syntheticTrust,
        }),
      onObservation(value) {
        f.setNow(performance.now())
        f.source.observe(value)
        resolve()
      },
      onUnavailable(epoch) {
        f.source.invalidate({ printerKey: 'a', epoch })
      },
    })
    const publish = setInterval(
      () =>
        simulator.publishReport({
          data: {
            state: 'printing',
            progress: 42,
            fan_speed_pct: 0,
            lights: [{ type: 2, status: 0 }],
            multi_color_box: [
              {
                id: 0,
                slots: [
                  {
                    index: 1,
                    type: 'PLA',
                    color: [1, 128, 255],
                    status: 5,
                    consumables_percent: 45,
                  },
                ],
              },
            ],
          },
        }),
      50,
    )
    try {
      await observed
      f.open(performance.now() + 5000)
      const printer = f.received.at(-1)?.printers[0]
      assert.deepEqual(printer?.fans, { part: 0 })
      assert.deepEqual(printer?.light, { chamber: false })
      assert.deepEqual(printer?.materials, [
        {
          slot: '0:1',
          materialType: 'PLA',
          colorHex: '0180FFFF',
          active: true,
          remainingPercent: 45,
        },
      ])
      assert.deepEqual(simulator.requests, [])
    } finally {
      clearInterval(publish)
      controller.abort()
      await collection.done
      f.source.close()
      await simulator.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
