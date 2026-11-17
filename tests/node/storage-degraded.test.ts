import test from 'node:test'
import assert from 'node:assert/strict'
import fs, {
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  createRequire,
  registerHooks,
  syncBuiltinESMExports,
} from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { projectStatus } from '../../packages/connector/src/status/local.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  FarmStatusSender,
  type FarmSnapshotProvider,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import {
  immutableAdmission,
  validatedStatusMessage,
  type VerifiedRtcAdmission,
} from '../../packages/connector/src/webrtc/readonly-session.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'

// Injected disk-full: every write-open of a queue file fails with ENOSPC while
// `disk.full` is set. Reads, directory syncs and unlinks keep working, as on a
// real full disk. Other files (journal, config) are never affected.
const disk = { full: false }
const realOpenSync = fs.openSync
fs.openSync = ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
  const writing =
    typeof flags === 'number'
      ? (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0
      : flags !== 'r'
  if (disk.full && writing && basename(String(path)).startsWith('telemetry.'))
    throw Object.assign(new Error('ENOSPC: no space left on device, open'), {
      code: 'ENOSPC',
      errno: -28,
      syscall: 'open',
    })
  return realOpenSync(path, flags, mode)
}) as typeof fs.openSync
syncBuiltinESMExports()
test.after(() => {
  fs.openSync = realOpenSync
  syncBuiltinESMExports()
})

const printer = (state: 'idle' | 'printing' = 'idle') => ({
  printerKey: 'printer',
  state,
  progress: 0,
  observedAt: Date.now(),
})
async function until<T>(read: () => T | Promise<T>, what: string) {
  const deadline = performance.now() + 15000
  for (;;) {
    const value = await read()
    if (value) return value
    if (performance.now() > deadline) assert.fail('Timed out: ' + what)
    await delay(20)
  }
}

/** Loopback Moonraker on an ephemeral port. `change()` pushes one state change. */
async function moonrakerFixture() {
  process.env.WS_NO_BUFFER_UTIL = '1'
  process.env.WS_NO_UTF_8_VALIDATE = '1'
  // `ws` is a dependency of the Connector package, not of the test root.
  const {
    WebSocketServer,
  }: typeof import('../../packages/connector/node_modules/@types/ws') =
    createRequire(
      new URL('../../packages/connector/package.json', import.meta.url),
    )('ws')
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    )
  })
  const sockets = new WebSocketServer({ server, perMessageDeflate: false })
  let state = 'printing',
    eventtime = 1
  sockets.on('connection', (socket) => {
    socket.on('error', () => {})
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as {
        id: number
        method: string
        params?: { objects?: Record<string, unknown> }
      }
      const all: Record<string, unknown> = {
        webhooks: { state: 'ready' },
        print_stats: { state },
        virtual_sdcard: { progress: 0.25 },
        extruder: { temperature: 200 },
        heater_bed: { temperature: 60 },
      }
      const result =
        request.method === 'printer.objects.list'
          ? { objects: [] }
          : {
              eventtime: ++eventtime,
              status: Object.fromEntries(
                Object.keys(request.params?.objects ?? {})
                  .filter((name) => name in all)
                  .map((name) => [name, all[name]]),
              ),
            }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    change() {
      state = state === 'printing' ? 'paused' : 'printing'
      const frame = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notify_status_update',
        params: [{ print_stats: { state } }, ++eventtime],
      })
      for (const socket of sockets.clients) socket.send(frame)
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise((resolve) => sockets.close(resolve))
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('queue degrades on ENOSPC, counts losses and recovers acknowledged state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-degraded-queue-'))
  const queue = new TelemetryQueue(directory, 1)
  try {
    const first = queue.enqueue(printer(), 1).eventId
    const second = queue.enqueue(printer('printing'), 2).eventId
    disk.full = true
    // Enqueueing stops without throwing; every dropped record is counted.
    queue.enqueue(printer(), 3)
    assert.equal(queue.storageDegraded, true)
    queue.enqueue(printer(), 4)
    assert.equal(queue.storageLost, 2)
    assert.equal(queue.depth, 2)
    assert.throws(() => queue.batch(5), /storage is degraded/)
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          async () => [],
          () => 5,
          new AbortController().signal,
        )
      ).status,
      'uncertain',
    )
    // A delivery already accepted by the server is acknowledged in memory.
    queue.acknowledge([first], 5)
    assert.equal(queue.depth, 1)
    // Bounded retry: still full means still degraded, nothing thrown.
    assert.equal(queue.retryStorage(), false)
    assert.equal(queue.storageDegraded, true)
    disk.full = false
    assert.equal(queue.retryStorage(), true)
    assert.equal(queue.storageDegraded, false)
    assert.deepEqual(
      queue.batch(6).records.map((record) => record.eventId),
      [second],
    )
    const third = queue.enqueue(printer(), 7).eventId
    queue.close()
    // The durable log holds exactly the unacknowledged records: the first is
    // not resent, the second and third are not lost.
    const reopened = new TelemetryQueue(directory, 8)
    try {
      assert.deepEqual(
        reopened.batch(8).records.map((record) => record.eventId),
        [second, third],
      )
      assert.equal(reopened.recovery.partialTail, false)
    } finally {
      reopened.close()
    }
  } finally {
    disk.full = false
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('acknowledgement that hits ENOSPC is kept and persisted on recovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-degraded-ack-'))
  const queue = new TelemetryQueue(directory, 1)
  try {
    const first = queue.enqueue(printer(), 1).eventId
    const second = queue.enqueue(printer('printing'), 2).eventId
    disk.full = true
    queue.acknowledge([first], 3)
    assert.equal(queue.storageDegraded, true)
    assert.equal(queue.depth, 1)
    disk.full = false
    assert.equal(queue.retryStorage(), true)
    queue.close()
    const reopened = new TelemetryQueue(directory, 4)
    try {
      assert.deepEqual(
        reopened.batch(4).records.map((record) => record.eventId),
        [second],
      )
    } finally {
      reopened.close()
    }
  } finally {
    disk.full = false
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a non-storage write failure still closes the queue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-degraded-closed-'))
  const queue = new TelemetryQueue(directory, 1)
  try {
    // A leftover cursor temporary is corruption (EEXIST), not a full disk.
    const id = queue.enqueue(printer(), 1).eventId
    queue.enqueue(printer('printing'), 2)
    writeFileSync(join(directory, 'telemetry.ack.tmp'), '', { mode: 0o600 })
    assert.throws(() => queue.acknowledge([id], 3))
    assert.equal(queue.storageDegraded, false)
    assert.throws(() => queue.enqueue(printer(), 4), /requires recovery/)
  } finally {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('local status reports storage-degraded and the loss counter', () => {
  const healthy = {
    queueDepth: 1,
    delivered: 2,
    retries: 0,
    credentialExpired: false,
  }
  assert.equal('storage' in projectStatus(healthy), false)
  const degraded = projectStatus({
    ...healthy,
    storageDegraded: true,
    storageLost: 3,
  })
  assert.equal(degraded.storage, 'storage-degraded')
  assert.equal(degraded.storageLost, 3)
})

test('RTC status feed marks snapshots storage-degraded and keeps sending', async () => {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const key = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const nonce = () => randomBytes(32).toString('base64url'),
    agent = randomUUID(),
    farm = randomUUID(),
    now = Date.now()
  const refs = [
    { assignmentId: randomUUID(), agentId: agent, printerKey: 'printer' },
  ]
  const assignments = await assignmentSetDigest(
    { farmId: farm, agentId: agent },
    refs,
  )
  const admission = immutableAdmission(
    {
      v: 2,
      purpose: 'read-only-rtc',
      transport_id: randomUUID(),
      farm_id: farm,
      agent_id: agent,
      account_id: 'test-account',
      key_id: randomUUID(),
      browser_public_key: key.publicKey,
      browser_thumbprint: key.thumbprint,
      connector_public_key_spki: identity.publicKeySpki,
      connector_fingerprint: identity.fingerprint,
      credential_jti: randomUUID(),
      origin: 'https://farm.example',
      audience: 'farm-test',
      browser_nonce: nonce(),
      connector_nonce: nonce(),
      issued_at: now - 1,
      expires_at: now + 3000,
      commands_enabled: false,
      offer_sha256: nonce(),
      answer_sha256: nonce(),
      browser_dtls: Array(32).fill('AA').join(':'),
      connector_dtls: Array(32).fill('BB').join(':'),
      assignment_count: assignments.count,
      assignment_digest: assignments.digest,
    },
    performance.now() + 2500,
  )
  let listener: ((value: VerifiedRtcAdmission) => void) | undefined
  let provider: Parameters<FarmSnapshotProvider>[0] | undefined
  let closed: string | undefined
  const sent: unknown[] = []
  const controller = new AbortController()
  let degraded = false
  new FarmStatusSender({
    client: {
      start: async () => {},
      subscribeVerifiedAdmission(callback) {
        listener = callback
        return () => {}
      },
      subscribeTerminal: () => () => {},
      sendStatus(message) {
        sent.push(message)
        return true
      },
      close(reason) {
        closed ??= reason ?? 'closed'
      },
    },
    assignmentRefs: refs,
    signal: controller.signal,
    storageDegraded: () => degraded,
    openSnapshots(input) {
      provider = input
      return { close() {} }
    },
  })
  try {
    listener?.(admission)
    const open = await until(() => provider ?? closed, 'snapshot provider')
    assert.equal(typeof open, 'object', 'sender closed: ' + closed)
    const complete = () => {
      const captured = performance.now()
      provider?.onComplete({
        assignmentRefs: refs,
        complete: true,
        printers: [printer('printing')],
        capturedAtMonoMs: captured,
        validUntilMonoMs: captured + 1000,
      })
    }
    complete()
    degraded = true
    complete()
    degraded = false
    complete()
    assert.equal(closed, undefined)
    // Frames stay valid for the receiving side's strict parser.
    const frames = sent.map((frame) => validatedStatusMessage(frame, refs))
    assert.deepEqual(
      frames.map((frame) => frame.storage),
      [undefined, 'degraded', undefined],
    )
    assert.equal(frames[1]?.printers[0]?.state, 'printing')
  } finally {
    controller.abort()
  }
})

test('control is refused with reason storage before the journal is touched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-degraded-control-'))
  const queueDirectory = join(directory, 'telemetry')
  const queue = new TelemetryQueue(queueDirectory, 1)
  const journal = openCommandJournal({
    directory: join(directory, 'pause-journal'),
    clock: Date.now,
  })
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  let driverCalls = 0
  const driver = new Proxy(
    {},
    {
      get: () => () => {
        driverCalls++
        throw new Error('The driver must not be reached')
      },
    },
  ) as Parameters<typeof createPauseDispatcher>[0]['driver']
  const dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        { issuer: 'fixture', kid: 'fixture', publicKey: issuer.publicKey },
      ],
      freshness: createOfflineAuthority().freshness,
    },
    clock: { wallNow: () => Date.now(), monotonicNow: () => performance.now() },
    journal,
    driver,
    storageDegraded: () => queue.storageDegraded,
  })
  const dispatch = () =>
    dispatcher.dispatch({
      wire: new Uint8Array([1]),
      capability: {},
      printerBinding: {},
    } as Parameters<typeof dispatcher.dispatch>[0])
  try {
    // Healthy storage reaches normal command validation.
    assert.deepEqual(await dispatch(), {
      kind: 'rejected',
      reason: 'invalid-command',
    })
    disk.full = true
    queue.enqueue(printer(), 2)
    assert.deepEqual(await dispatch(), { kind: 'rejected', reason: 'storage' })
    disk.full = false
    assert.equal(queue.retryStorage(), true)
    assert.deepEqual(await dispatch(), {
      kind: 'rejected',
      reason: 'invalid-command',
    })
    assert.equal(driverCalls, 0)
  } finally {
    disk.full = false
    await dispatcher.close?.()
    closeCommandJournal(journal)
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('agent stays up through ENOSPC, reports degraded status and resumes uploads', async () => {
  const remote = await moonrakerFixture()
  const directory = mkdtempSync(join(tmpdir(), 'storage-degraded-agent-'))
  const controller = new AbortController()
  // Replace only the cloud transport: bodies are recorded and accepted on demand.
  const cloud = {
    bodies: [] as string[][],
    accept: true,
    waiting: [] as Array<() => void>,
  }
  Object.assign(globalThis, { storageDegradedCloud: cloud })
  const hooks = registerHooks({
    load(url, context, next) {
      if (url.endsWith('/cloud/authenticated-http-telemetry.ts'))
        return {
          format: 'module',
          shortCircuit: true,
          source: `export function createAuthenticatedTelemetrySender() {
            const cloud = globalThis.storageDegradedCloud
            return async (body) => {
              const ids = JSON.parse(body).map((record) => record.eventId)
              cloud.bodies.push(ids)
              if (!cloud.accept) await new Promise((resolve) => cloud.waiting.push(resolve))
              return ids
            }
          }`,
        }
      return next(url, context)
    },
  })
  // An ephemeral port: reserve one, release it, hand it to the agent.
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  assert.ok(address && typeof address === 'object')
  const statusPort = address.port
  await new Promise((resolve) => probe.close(resolve))
  type Status = {
    delivered: number
    queueDepth: number
    storage?: string
    storageLost?: number
  }
  const status = async () =>
    (await (
      await fetch(`http://127.0.0.1:${statusPort}/status`)
    ).json()) as Status
  // Before the agent listens there is nothing to read yet.
  const started = () => status().catch(() => undefined)
  let running: Promise<void> | undefined
  try {
    const identity = loadOrCreateIdentity(directory)
    const agent = randomUUID(),
      farm = randomUUID()
    const configPath = join(directory, 'config.json'),
      credentialPath = join(directory, 'credential.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [remote.origin],
          printers: [{ printerKey: 'printer', origin: remote.origin }],
        },
        assignments: [
          {
            assignment_id: randomUUID(),
            agent_id: agent,
            farm_id: farm,
            printer_key: 'printer',
            moonraker_origin: remote.origin,
          },
        ],
        telemetry: {
          endpoint: 'https://127.0.0.1:1/api/connector/telemetry',
          audience: 'fixture',
          retryMinMs: 100,
          retryMaxMs: 200,
          idleMs: 100,
        },
      }),
      { mode: 0o600 },
    )
    writeFileSync(
      credentialPath,
      JSON.stringify({
        version: 1,
        expected_fingerprint: identity.fingerprint,
        approval: {
          status: 'approved',
          agent_id: agent,
          farm_id: farm,
          device_token:
            'e30.' +
            Buffer.from(JSON.stringify({ jti: randomUUID() })).toString(
              'base64url',
            ) +
            '.AA',
          expires_at: Date.now() + 120000,
        },
      }),
      { mode: 0o600 },
    )
    const { runConnectorAgent } =
      await import('../../packages/connector/src/runtime/agent.ts')
    const diagnostics: Array<{ kind: string; lost?: number }> = []
    let failure: { error: unknown } | undefined
    let stopped = false
    running = runConnectorAgent({
      configPath,
      credentialPath,
      dataDirectory: directory,
      statusPort,
      signal: controller.signal,
      onDiagnostic: (value) => diagnostics.push(value),
    }).then(
      () => {
        stopped = true
      },
      (error: unknown) => {
        failure = { error }
      },
    )
    const alive = () => {
      if (failure) throw failure.error
      assert.equal(stopped, false, 'agent stopped')
      return true
    }
    // Healthy baseline: the first record is uploaded and acknowledged.
    await until(
      async () => alive() && ((await started())?.delivered ?? 0) >= 1,
      'upload',
    )
    const before = cloud.bodies.flat()

    // A delivery is in flight when the disk fills up.
    cloud.accept = false
    remote.change()
    await until(() => alive() && cloud.waiting.length === 1, 'held delivery')
    const inFlight = cloud.bodies.at(-1) ?? []
    disk.full = true
    remote.change()
    await until(async () => {
      const value = await status()
      return alive() && !!value.storage && (value.storageLost ?? 0) >= 1
    }, 'degraded status')
    const degraded = await status()
    assert.equal(degraded.storage, 'storage-degraded')
    const page = await (await fetch(`http://127.0.0.1:${statusPort}/`)).text()
    assert.match(page, /Armazenamento da fila<\/dt><dd>Degradado/)
    // The server accepts the in-flight batch while storage is still degraded.
    cloud.accept = true
    cloud.waiting.splice(0).forEach((release) => release())
    await until(
      () => diagnostics.some((value) => value.kind === 'storage-degraded'),
      'storage-degraded diagnostic',
    )
    // The agent keeps running and keeps retrying while the disk stays full.
    await delay(500)
    alive()
    assert.equal((await status()).storage, 'storage-degraded')
    const uploadsWhileDegraded = cloud.bodies.length

    // Space is freed: storage recovers and uploads resume.
    disk.full = false
    await until(async () => alive() && !(await status()).storage, 'recovery')
    assert.ok(diagnostics.some((value) => value.kind === 'storage-recovered'))
    remote.change()
    await until(
      () => alive() && cloud.bodies.length > uploadsWhileDegraded,
      'resumed upload',
    )
    const resumed = cloud.bodies.slice(uploadsWhileDegraded).flat()
    // Acknowledged state survived: nothing accepted earlier is sent again.
    for (const id of [...before, ...inFlight])
      assert.equal(resumed.includes(id), false, 'acknowledged record resent')
    await until(async () => (await status()).queueDepth === 0, 'queue drained')
    const final = await status()
    assert.ok((final.storageLost ?? 0) >= 1)

    controller.abort()
    await running
    if (failure) throw failure.error
    // Dropped records are never reported as queued.
    const collected = diagnostics.find((value) => value.kind === 'summary')
    assert.ok(collected && 'queued' in collected)
    assert.equal(collected.queued, cloud.bodies.flat().length)
    const summary = diagnostics.find((value) => value.kind === 'agent-summary')
    assert.ok(summary && 'storageLost' in summary)
    assert.equal(summary.storageLost, final.storageLost)
    // The durable log agrees with the acknowledged state.
    assert.equal(
      readFileSync(join(directory, 'telemetry', 'telemetry.jsonl'), 'utf8'),
      '',
    )
  } finally {
    disk.full = false
    controller.abort()
    await running
    hooks.deregister()
    Reflect.deleteProperty(globalThis, 'storageDegradedCloud')
    await remote.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
