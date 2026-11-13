import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { readPrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import type { FarmSnapshotProvider } from '../../packages/connector/src/webrtc/farm-status-sender.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kobralink-runtime-'))
  const agent = randomUUID(),
    farm = randomUUID(),
    assignment = randomUUID()
  const target = {
    backend: 'kobralink',
    version: 2,
    bridgeInstance: 'owned-bridge',
    origin: 'http://127.0.0.1:8080',
    deviceId: 'immutable-device',
    id: 'printer',
    printerKey: 'kobra',
    revision: 1,
    credentialFile: join(dir, 'secret.json'),
  }
  const secret = {
    version: 1,
    bridgeInstance: target.bridgeInstance,
    origin: target.origin,
    deviceId: target.deviceId,
    id: target.id,
    printerKey: target.printerKey,
    revision: 1,
    name: 'machine',
    email: 'machine@example.test',
    password: 'synthetic-only',
  }
  const save = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  save(target.credentialFile, secret)
  const runtime = {
    version: 2,
    collection: {
      version: 2,
      allowedOrigins: [],
      printers: [],
      kobralink: { allowedOrigins: [target.origin], printers: [target] },
    },
    assignments: [
      {
        assignment_id: assignment,
        agent_id: agent,
        farm_id: farm,
        printer_key: target.printerKey,
        backend: target.backend,
        bridgeInstance: target.bridgeInstance,
        origin: target.origin,
        deviceId: target.deviceId,
        id: target.id,
        revision: 1,
      },
    ],
    telemetry: { endpoint: 'https://farm.example/telemetry', audience: 'test' },
  }
  const path = join(dir, 'runtime.json')
  const read = () => {
    save(path, runtime)
    return readAgentRuntimeConfig(path, { agent_id: agent, farm_id: farm })
  }
  return {
    dir,
    agent,
    farm,
    assignment,
    target,
    secret,
    runtime,
    save,
    read,
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

for (const mode of [
  'fresh',
  'null',
  'stale',
  'unknown',
  'missing-progress',
  'wrong-device',
  'auth',
] as const)
  test(`actual collector and snapshot: ${mode}`, async () => {
    const f = fixture(),
      controller = new AbortController()
    const config = f.read()
    const refs = config.assignments.map((a) => ({
      assignmentId: a.assignment_id,
      agentId: a.agent_id,
      printerKey: a.printer_key,
    }))
    const source = createFarmSnapshotSource({ assignmentRefs: refs })
    const queue = new TelemetryQueue(join(f.dir, 'queue'), Date.now())
    let snapshots = 0,
      unavailable = 0,
      requests = 0
    const agent = f.agent
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
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      await collectIntoQueue({
        config: config.collection,
        queue,
        signal: controller.signal,
        kobraFetch: async (url) => {
          requests++
          if (url.includes('/api/auth/'))
            return new Response(null, {
              status: mode === 'auth' ? 401 : 200,
              headers: {
                'set-cookie': 'better-auth.session_token=synthetic; HttpOnly',
              },
            })
          return Response.json({
            id: 'printer',
            deviceId: mode === 'wrong-device' ? 'foreign' : f.target.deviceId,
            name: 'Kobra',
            live:
              mode === 'null'
                ? null
                : {
                    connected: true,
                    updatedAt: Date.now() - (mode === 'stale' ? 20000 : 0),
                    printState: mode === 'unknown' ? 'unknown' : 'printing',
                    ...(mode === 'missing-progress' ? {} : { progress: 0.25 }),
                  },
          })
        },
        onRawObservation(value) {
          source.observe(value)
        },
        onRawUnavailable(event) {
          source.invalidate(event)
          unavailable++
        },
        onDiagnostic(d) {
          if (d.kind === 'queued' || d.kind === 'unavailable')
            controller.abort()
        },
      })
      source.open({
        binding,
        assignmentRefs: refs,
        signal: new AbortController().signal,
        deadlineMonoMs: performance.now() + 5000,
        onComplete(value) {
          snapshots++
          assert.equal(value.printers[0]?.progress, 0.25)
        },
        onUnavailable() {
          unavailable++
        },
      })
      assert.equal(queue.depth, mode === 'fresh' ? 1 : 0)
      assert.equal(snapshots, mode === 'fresh' ? 1 : 0)
      if (mode !== 'fresh') assert.ok(unavailable > 0)
      assert.ok(requests > 0)
    } finally {
      clearTimeout(timer)
      controller.abort()
      source.close()
      queue.close()
      f.close()
    }
  })

test('private custody and command rejection fail closed', async () => {
  const f = fixture()
  try {
    const config = f.read(),
      handle = config.bindingFor(f.assignment)
    assert.ok(handle)
    assert.equal(readPrinterBinding(handle), null)
    const router = createPauseDriverRouter({
      allowedOrigins: [],
      limits: config.collection.limits,
      clock: { monotonicNow: () => performance.now() },
      observe: () => true,
    })
    await assert.rejects(
      router.prepare({ binding: handle, signal: new AbortController().signal }),
    )
    f.save(f.target.credentialFile, { ...f.secret, deviceId: 'foreign' })
    assert.throws(f.read, /context mismatch/)
    f.save(f.target.credentialFile, f.secret)
    chmodSync(f.target.credentialFile, 0o644)
    assert.throws(f.read, /private/)
    rmSync(f.target.credentialFile)
    assert.throws(f.read)
    symlinkSync('absent', f.target.credentialFile)
    assert.throws(f.read)
  } finally {
    f.close()
  }
})

test('mixed mapping, wrong bridge, strict legacy and restart custody', () => {
  const f = fixture()
  try {
    const config = f.read()
    assert.equal(config.collection.version, 2)
    assert.equal(f.read().assignments.length, 1)
    const mixed = JSON.parse(JSON.stringify(f.runtime))
    mixed.collection.allowedOrigins = ['http://127.0.0.1:7125']
    mixed.collection.printers = [
      { printerKey: 'moon', origin: 'http://127.0.0.1:7125' },
    ]
    mixed.assignments.push({
      assignment_id: randomUUID(),
      agent_id: f.agent,
      farm_id: f.farm,
      printer_key: 'moon',
      moonraker_origin: 'http://127.0.0.1:7125',
    })
    const path = join(f.dir, 'mixed.json')
    f.save(path, mixed)
    assert.equal(
      readAgentRuntimeConfig(path, { agent_id: f.agent, farm_id: f.farm })
        .assignments.length,
      2,
    )
    f.runtime.assignments[0]!.bridgeInstance = 'foreign'
    assert.throws(f.read, /assignment mismatch/)
    f.runtime.assignments[0]!.bridgeInstance = f.target.bridgeInstance
    f.runtime.collection.kobralink.allowedOrigins = ['http://127.0.0.1:9090']
    assert.throws(f.read)
  } finally {
    f.close()
  }
})

test('cancellation aborts an active synthetic request and settles collection', async () => {
  const f = fixture(),
    controller = new AbortController(),
    config = f.read()
  const queue = new TelemetryQueue(join(f.dir, 'queue'), Date.now())
  let aborted = false
  try {
    await collectIntoQueue({
      config: config.collection,
      queue,
      signal: controller.signal,
      onDiagnostic: () => {},
      kobraFetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(Error('aborted'))
            },
            { once: true },
          )
          controller.abort()
        }),
    })
    assert.equal(aborted, true)
    assert.equal(queue.depth, 0)
  } finally {
    controller.abort()
    queue.close()
    f.close()
  }
})

test('serial recovery preserves source freshness and restart reauthenticates', async () => {
  const f = fixture()
  try {
    for (let run = 0; run < 2; run++) {
      const controller = new AbortController(),
        config = f.read(),
        queue = new TelemetryQueue(join(f.dir, 'queue'), Date.now())
      let calls = 0,
        auth = 0,
        active = 0,
        maximum = 0
      const times: number[] = []
      const stamp = Date.now()
      const timeout = setTimeout(() => controller.abort(), 7000)
      try {
        await collectIntoQueue({
          config: config.collection,
          queue,
          signal: controller.signal,
          onDiagnostic: () => {},
          kobraFetch: async (url) => {
            active++
            maximum = Math.max(maximum, active)
            try {
              if (url.includes('/api/auth/')) {
                auth++
                return new Response(null, {
                  headers: {
                    'set-cookie': 'better-auth.session_token=synthetic',
                  },
                })
              }
              calls++
              if (calls === 1) return new Response(null, { status: 503 })
              return Response.json({
                id: 'printer',
                deviceId: f.target.deviceId,
                name: 'Kobra',
                live: {
                  connected: true,
                  updatedAt: stamp,
                  printState: 'printing',
                  progress: 0.5,
                },
              })
            } finally {
              active--
            }
          },
          onRawObservation(value) {
            times.push(value.fieldObservedAtMonoMs.progress)
            if (times.length === 2) controller.abort()
          },
        })
        assert.equal(times.length, 2)
        assert.equal(times[0], times[1])
        assert.equal(maximum, 1)
        assert.equal(auth, 2)
      } finally {
        clearTimeout(timeout)
        controller.abort()
        queue.close()
      }
    }
  } finally {
    f.close()
  }
}, 10000)

test('KobraLink cannot select the camera runtime', () => {
  const f = fixture()
  try {
    const path = join(f.dir, 'camera.json')
    f.save(path, {
      ...f.runtime,
      camera: {
        helper: { path: '/synthetic/helper', sha256: 'a'.repeat(64) },
        cameras: [
          {
            cameraId: 'camera',
            assignmentId: f.assignment,
            source: { address: '127.0.0.1', port: 8081, path: '/stream' },
          },
        ],
      },
    })
    assert.throws(
      () =>
        readAgentRuntimeConfig(path, { agent_id: f.agent, farm_id: f.farm }),
      /Camera assignment/,
    )
  } finally {
    f.close()
  }
})
