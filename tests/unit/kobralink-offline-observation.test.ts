import { test, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import {
  createFarmSnapshotSource,
  type RawPrinterObservation,
} from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'

const modes = [
  'available',
  'offline',
  'auth',
  'http',
  'invalid',
  'identity',
  'stale',
  'unknown',
  'pausing',
  'lost',
  'null',
  'missing-progress',
  'replay',
] as const
type Mode = (typeof modes)[number]

async function fixture() {
  await import('../../packages/connector/src/moonraker/subscription.ts')
  vi.useFakeTimers({
    now: 1700000000000,
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'],
  })
  await vi.advanceTimersByTimeAsync(1000)
  const dir = mkdtempSync(join(tmpdir(), 'kobra-offline-'))
  const controller = new AbortController()
  const target = {
    backend: 'kobralink',
    version: 2,
    bridgeInstance: 'bridge',
    origin: 'http://127.0.0.1:8080',
    deviceId: 'device',
    id: 'printer',
    printerKey: 'kobra',
    revision: 1,
    credentialFile: join(dir, 'credential.json'),
  }
  const { backend: _backend, credentialFile: _file, ...identity } = target
  writeFileSync(
    target.credentialFile,
    JSON.stringify({
      ...identity,
      version: 1,
      name: 'test',
      email: 'test@example.test',
      password: 'synthetic-password',
    }),
    { mode: 0o600 },
  )
  const config = parseLocalCollectorConfig({
    version: 2,
    allowedOrigins: [],
    printers: [],
    kobralink: { allowedOrigins: [target.origin], printers: [target] },
  })
  const queue = new TelemetryQueue(join(dir, 'queue'), Date.now())
  const refs = [
    { assignmentId: randomUUID(), agentId: randomUUID(), printerKey: 'kobra' },
  ]
  const source = createFarmSnapshotSource({ assignmentRefs: refs })
  const binding: Parameters<FarmSnapshotProvider>[0]['binding'] = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: refs[0]!.agentId,
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
  let mode: Mode = 'available'
  const raw: RawPrinterObservation[] = []
  const snapshots: CompleteFarmSnapshot[] = []
  let unavailable = 0
  const run = collectIntoQueue({
    config,
    queue,
    signal: controller.signal,
    onDiagnostic() {},
    onRawObservation(value) {
      raw.push(value)
      source.observe(value)
    },
    onRawUnavailable: source.invalidate,
    kobraFetch: async (url, init) => {
      if (url.includes('/api/auth/')) {
        expect(url).toContain('/sign-in/email')
        return new Response(null, {
          headers: { 'set-cookie': 'better-auth.session_token=synthetic' },
        })
      }
      expect(init.method).toBe('GET')
      expect(url).toBe(target.origin + '/api/v1/printers/printer')
      expect(init.headers).toHaveProperty(
        'Cookie',
        'better-auth.session_token=synthetic',
      )
      if (mode === 'lost') throw Error('synthetic transport failure')
      if (mode === 'auth' || mode === 'http')
        return new Response(null, { status: mode === 'auth' ? 401 : 503 })
      return Response.json({
        id: 'printer',
        deviceId: mode === 'identity' ? 'rebound' : 'device',
        name: 'Kobra',
        live:
          mode === 'null'
            ? null
            : {
                connected: !['offline', 'invalid', 'identity'].includes(mode),
                updatedAt:
                  mode === 'replay'
                    ? 1700000001000
                    : Date.now() -
                      (mode === 'offline' || mode === 'stale' ? 60000 : 0),
                printState:
                  mode === 'unknown' || mode === 'pausing' ? mode : 'printing',
                ...(mode === 'missing-progress'
                  ? {}
                  : { progress: mode === 'invalid' ? 'invalid' : 0.75 }),
              },
      })
    },
  })
  await vi.advanceTimersByTimeAsync(0)
  source.open({
    binding,
    assignmentRefs: refs,
    signal: new AbortController().signal,
    deadlineMonoMs: performance.now() + 60000,
    onComplete(value) {
      snapshots.push(value)
    },
    onUnavailable() {
      unavailable++
    },
  })
  return {
    raw,
    snapshots,
    source,
    controller,
    run,
    unavailable: () => unavailable,
    async step(next: Mode) {
      mode = next
      await vi.advanceTimersByTimeAsync(1000)
    },
    async close() {
      controller.abort()
      await run
      source.close()
      queue.close()
      rmSync(dir, { recursive: true })
      vi.useRealTimers()
    },
  }
}

test('authenticated available/offline/available reaches one real snapshot subscription without invented print telemetry', async () => {
  const f = await fixture()
  try {
    expect(f.snapshots.at(-1)?.printers[0]?.state).toBe('printing')
    await f.step('offline')
    expect(f.snapshots.at(-1)?.printers[0]).toEqual({
      printerKey: 'kobra',
      state: 'offline',
      observedAt: Date.now(),
    })
    expect(f.raw.at(-1)?.fieldObservedAtMonoMs).toEqual({
      connection: performance.now(),
    })
    const firstOffline = f.snapshots.at(-1)!
    await f.step('offline')
    expect(f.snapshots.at(-1)!.validUntilMonoMs).toBe(
      firstOffline.validUntilMonoMs + 1000,
    )
    await f.step('available')
    expect(f.snapshots.at(-1)?.printers[0]?.progress).toBe(0.75)
    expect(f.raw.every((value) => value.epoch === 1)).toBe(true)
    expect(f.unavailable()).toBe(0)
    expect(
      f.snapshots.every(
        (value) => value.assignmentRefs[0]?.printerKey === 'kobra',
      ),
    ).toBe(true)
  } finally {
    await f.close()
  }
})

for (const mode of modes.filter(
  (value) => value !== 'available' && value !== 'offline' && value !== 'replay',
)) {
  test(`${mode} cannot become offline or refresh the complete snapshot`, async () => {
    const f = await fixture()
    try {
      const count = f.snapshots.length
      await f.step(mode)
      expect(f.raw).toHaveLength(1)
      expect(f.snapshots).toHaveLength(count)
      expect(f.unavailable()).toBe(1)
    } finally {
      await f.close()
    }
  })
}

test('offline expires when collector stops polling', async () => {
  const f = await fixture()
  try {
    await f.step('offline')
    f.controller.abort()
    await f.run
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.unavailable()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.unavailable()).toBe(1)
    expect(f.snapshots.at(-1)?.printers[0]?.state).toBe('offline')
  } finally {
    await f.close()
  }
})

test('old print telemetry cannot resume after a current disconnected response', async () => {
  const f = await fixture()
  try {
    await f.step('offline')
    const count = f.snapshots.length
    await f.step('replay')
    expect(f.snapshots).toHaveLength(count)
    expect(f.unavailable()).toBe(1)
  } finally {
    await f.close()
  }
})
