import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigurationTarget,
  SpoolmanConfigurationTarget,
  configurationTargetHash,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import type { ConfigurationRequestFrame } from '../../packages/farm-protocol/src/configuration-frames.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { SpoolmanConfig } from '../../packages/connector/src/spoolman/config.ts'
import {
  readSpoolmanAuthorization,
  spoolmanAuthorization,
} from '../../packages/connector/src/spoolman/credential.ts'
import { createBoundedSpoolmanReader } from '../../packages/connector/src/spoolman/bounded-read.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { createProvisioningEngine } from '../../packages/connector/src/provisioning/engine.ts'
import {
  trustProvisioningAuthority,
  type ProvisioningContext,
} from '../../packages/connector/src/provisioning/authority.ts'
import { testSpoolmanConnection } from '../../packages/connector/src/provisioning/spoolman.ts'

const ORIGIN = 'http://192.168.1.60:7912'
const SECRET = 'spoolman-secret-token-9d41'
const directories: string[] = []
test.after(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true })
})

type FakeMode = 'ok' | 'down' | 'proxy-auth' | 'html' | 'redirect'
function spoolmanFetch(mode: FakeMode, seen: Record<string, string>[] = []) {
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url: String(input), ...headers })
    if (mode === 'down') throw new TypeError('connect ECONNREFUSED')
    if (mode === 'redirect') throw new TypeError('redirect')
    if (
      mode === 'proxy-auth' &&
      headers['authorization'] !== `Bearer ${SECRET}`
    )
      return new Response('nope', { status: 401 })
    if (mode === 'html')
      return new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return impl
}

function world(mode: FakeMode = 'ok') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spoolman-farm-')))
  directories.push(dir)
  const farm = randomUUID()
  const agent = randomUUID()
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const signer = identity.configurationReceiptSigner()
  const runtimeConfigPath = join(dir, 'runtime.json')
  const legacy = {
    version: 1,
    collection: {
      version: 1,
      allowedOrigins: ['http://127.0.0.1:7125'],
      printers: [{ printerKey: 'voron', origin: 'http://127.0.0.1:7125' }],
    },
    assignments: [
      {
        assignment_id: randomUUID(),
        farm_id: farm,
        agent_id: agent,
        printer_key: 'voron',
        moonraker_origin: 'http://127.0.0.1:7125',
      },
    ],
    telemetry: { endpoint: 'https://farm.example/telemetry', audience: 'test' },
  }
  writeFileSync(runtimeConfigPath, JSON.stringify(legacy), { mode: 0o600 })
  const seen: Record<string, string>[] = []
  const scope = { runtimeConfigPath, agent_id: agent, farm_id: farm }
  const engine = createProvisioningEngine({
    stateDirectory: join(dir, 'state'),
    runtime: scope,
    connector: signer,
    managedBridge: null,
    printerNetworks: ['192.168.1.0/24'],
    spoolmanFetch: spoolmanFetch(mode, seen),
    authority: trustProvisioningAuthority({
      isCurrent: async (context) => context.role === 'owner',
      acceptsInventoryAck: async () => true,
    }),
  })
  const binding = {
    account_id: 'owner-1',
    role: 'owner' as const,
    farm_id: farm,
    agent_id: agent,
    key_id: randomUUID(),
    credential_jti: randomUUID(),
    transport_id: randomUUID(),
    connector_fingerprint: signer.fingerprint,
  }
  const send = (frame: ConfigurationRequestFrame) =>
    engine.handle({
      frame,
      context: {
        ...binding,
        action: frame.type,
        capability_id: randomUUID(),
        admission_nonce: 'A'.repeat(43),
      } satisfies ProvisioningContext,
    })
  return { dir, farm, scope, engine, send, seen, legacy, runtimeConfigPath }
}

function target(extra: Record<string, unknown> = {}) {
  return SpoolmanConfigurationTarget.parse({
    v: 1,
    protocol: 'config-v1',
    backend: 'spoolman',
    model: { family: 'spoolman', provisional: true },
    origin: ORIGIN,
    ...extra,
  })
}
const frameBase = () => ({
  v: 1 as const,
  protocol: 'config-v1' as const,
  request_id: randomUUID(),
  operation_id: randomUUID(),
})

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name)],
  )
}

test('target schema: origin only, one credential method, no extras', () => {
  assert.ok(target())
  assert.ok(target({ token: SECRET }))
  assert.ok(target({ username: 'ana', password: 'pw' }))
  for (const bad of [
    { origin: 'http://user:pw@host:1' },
    { origin: 'http://host:1/path' },
    { origin: 'ftp://host' },
    { token: SECRET, username: 'a', password: 'b' },
    { username: 'a' },
    { username: 'a:b', password: 'c' },
    { token: 'has space' },
    { headers: { x: 'y' } },
  ])
    assert.equal(
      SpoolmanConfigurationTarget.safeParse({
        v: 1,
        protocol: 'config-v1',
        backend: 'spoolman',
        model: { family: 'spoolman', provisional: true },
        origin: ORIGIN,
        ...bad,
      }).success,
      false,
      JSON.stringify(bad),
    )
  assert.equal(ConfigurationTarget.parse(target()).backend, 'spoolman')
})

test('connection test reports reachable / unreachable / unauthorized', async () => {
  const credential = { token: SECRET }
  assert.equal(
    await testSpoolmanConnection({
      origin: ORIGIN,
      credential,
      fetch: spoolmanFetch('ok'),
    }),
    'reachable',
  )
  assert.equal(
    await testSpoolmanConnection({
      origin: ORIGIN,
      fetch: spoolmanFetch('down'),
    }),
    'unreachable',
  )
  assert.equal(
    await testSpoolmanConnection({
      origin: ORIGIN,
      fetch: spoolmanFetch('html'),
    }),
    'unreachable',
  )
  assert.equal(
    await testSpoolmanConnection({
      origin: ORIGIN,
      fetch: spoolmanFetch('proxy-auth'),
    }),
    'unauthorized',
  )
  assert.equal(
    await testSpoolmanConnection({
      origin: ORIGIN,
      credential,
      fetch: spoolmanFetch('proxy-auth'),
    }),
    'reachable',
  )
  assert.equal(
    await testSpoolmanConnection({
      origin: ORIGIN,
      timeoutMs: 20,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('t'))),
        )) as typeof fetch,
    }),
    'unreachable',
  )
})

test('prepare -> commit stores origin and credential only on the Connector', async () => {
  const w = world('proxy-auth')
  const t = target({ token: SECRET })
  const hash = await configurationTargetHash(t)
  const prepare = {
    ...frameBase(),
    type: 'prepare' as const,
    expected_revision: 0,
    target: t,
  }
  const prepared = await w.send(prepare)
  assert.equal(prepared.type, 'result')
  if (prepared.type !== 'result') return
  assert.equal(prepared.state, 'prepared')
  // The test ran on the Connector with the supplied credential.
  assert.equal(w.seen.at(-1)?.['authorization'], `Bearer ${SECRET}`)
  const commit = await w.send({
    ...frameBase(),
    type: 'commit',
    operation_id: prepare.operation_id,
    expected_revision: 0,
    target_sha256: hash,
    prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
  })
  assert.equal(commit.type, 'result')
  if (commit.type !== 'result') return
  assert.equal(commit.state, 'local-committed')
  assert.equal(commit.receipt.committed_revision, 1)

  // Runtime now carries the farm Spoolman; the strict reader accepts it.
  const runtime = readAgentRuntimeConfig(w.runtimeConfigPath, w.scope)
  assert.ok(runtime)
  const stored = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
  assert.equal(stored.collection.spoolman.origin, ORIGIN)
  assert.equal(stored.collection.spoolman.farmId, w.farm)
  const parsed = SpoolmanConfig.parse(stored.collection.spoolman)
  assert.equal(
    readSpoolmanAuthorization(parsed.credentialFile, ORIGIN),
    `Bearer ${SECRET}`,
  )
  // Credentials live only in the private credential file, mode 0600.
  assert.equal(statSync(parsed.credentialFile!).mode & 0o077, 0)
  assert.equal(JSON.stringify(stored).includes(SECRET), false)
  for (const file of files(w.dir)) {
    const text = readFileSync(file, 'utf8')
    if (file === parsed.credentialFile) continue
    assert.equal(text.includes(SECRET), false, `secret leaked into ${file}`)
  }
  // Wire responses never echo the secret.
  assert.equal(JSON.stringify([prepared, commit]).includes(SECRET), false)
  // A setting is not printer inventory: nothing to confirm with the server.
  assert.deepEqual(await w.engine.pendingInventoryConfirmations(), [])
  assert.equal((await w.engine.unconfirmedAssignmentIds()).size, 0)
})

test('unauthorized and unreachable fail prepare with a typed code and keep nothing', async () => {
  for (const [mode, code] of [
    ['proxy-auth', 'spoolman-unauthorized'],
    ['down', 'spoolman-unreachable'],
    ['html', 'spoolman-unreachable'],
  ] as const) {
    const w = world(mode)
    const response = await w.send({
      ...frameBase(),
      type: 'prepare',
      expected_revision: 0,
      target: target(), // no credential
    })
    assert.equal(response.type, 'error')
    if (response.type === 'error') assert.equal(response.code, code)
    const after = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
    assert.deepEqual(after, w.legacy)
    assert.deepEqual(
      files(join(w.dir, 'state', 'credentials')),
      [],
      'no staged credential survives a failed test',
    )
  }
})

test('cancel discards staged credentials; nothing is written to runtime', async () => {
  const w = world()
  const t = target({ username: 'ana', password: 'p4ss' })
  const prepare = {
    ...frameBase(),
    type: 'prepare' as const,
    expected_revision: 0,
    target: t,
  }
  const prepared = await w.send(prepare)
  assert.equal(prepared.type, 'result')
  assert.equal(files(join(w.dir, 'state', 'credentials')).length, 1)
  const cancelled = await w.send({
    ...frameBase(),
    type: 'cancel',
    operation_id: prepare.operation_id,
    expected_revision: 0,
    target_sha256: await configurationTargetHash(t),
  })
  assert.equal(cancelled.type, 'unknown')
  assert.deepEqual(files(join(w.dir, 'state', 'credentials')), [])
  assert.deepEqual(
    JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8')),
    w.legacy,
  )
})

test('credential rotation preserves the service id, while a changed origin rotates it', async () => {
  const w = world()
  async function apply(t: ReturnType<typeof target>, revision: number) {
    const prepare = {
      ...frameBase(),
      type: 'prepare' as const,
      expected_revision: revision,
      target: t,
    }
    const prepared = await w.send(prepare)
    assert.equal(prepared.type, 'result')
    if (prepared.type !== 'result') throw new Error('prepare')
    const commit = await w.send({
      ...frameBase(),
      type: 'commit',
      operation_id: prepare.operation_id,
      expected_revision: revision,
      target_sha256: await configurationTargetHash(t),
      prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
    })
    assert.equal(commit.type === 'result' && commit.state, 'local-committed')
  }
  await apply(target({ token: SECRET }), 0)
  const first = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
  await apply(target({ username: 'ana', password: 'novo' }), 1)
  const second = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
  assert.equal(
    second.collection.spoolman.serviceId,
    first.collection.spoolman.serviceId,
  )
  assert.equal(
    readSpoolmanAuthorization(
      second.collection.spoolman.credentialFile,
      ORIGIN,
    ),
    spoolmanAuthorization({ username: 'ana', password: 'novo' }),
  )
  await apply(target({ origin: 'http://192.168.1.61:7912' }), 2)
  const third = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
  assert.notEqual(
    third.collection.spoolman.serviceId,
    second.collection.spoolman.serviceId,
  )
  const replacement = randomUUID()
  await apply(
    target({ origin: 'http://192.168.1.61:7912', service_id: replacement }),
    3,
  )
  const fourth = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
  assert.equal(fourth.collection.spoolman.serviceId, replacement)
  await apply(target({ service_id: replacement }), 4)
  const fifth = JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8'))
  assert.equal(fifth.collection.spoolman.serviceId, replacement)
  readAgentRuntimeConfig(w.runtimeConfigPath, w.scope)
})

test('a lower-role, replayed or stale-revision request cannot configure', async () => {
  const w = world()
  const stale = await w.send({
    ...frameBase(),
    type: 'prepare',
    expected_revision: 5,
    target: target(),
  })
  assert.equal(stale.type, 'error')
  if (stale.type === 'error') assert.equal(stale.code, 'revision-conflict')
  const response = await w.engine.handle({
    frame: {
      ...frameBase(),
      type: 'prepare',
      expected_revision: 0,
      target: target(),
    },
    context: {
      account_id: 'viewer',
      role: 'viewer',
      farm_id: w.farm,
      agent_id: w.scope.agent_id,
      key_id: randomUUID(),
      credential_jti: randomUUID(),
      transport_id: randomUUID(),
      connector_fingerprint: 'SHA256:' + 'A'.repeat(43),
      capability_id: randomUUID(),
      admission_nonce: 'A'.repeat(43),
      action: 'prepare',
    },
  })
  assert.equal(response.type, 'error')
  assert.deepEqual(
    JSON.parse(readFileSync(w.runtimeConfigPath, 'utf8')),
    w.legacy,
  )
})

test('existing Connector-local Spoolman configs keep working unchanged', async () => {
  // Legacy shape: no credentialFile.
  const legacy = SpoolmanConfig.parse({
    origin: ORIGIN,
    farmId: randomUUID(),
    serviceId: randomUUID(),
  })
  assert.equal(legacy.credentialFile, undefined)
  assert.equal(
    readSpoolmanAuthorization(legacy.credentialFile, ORIGIN),
    undefined,
  )
  const seen: Record<string, string>[] = []
  const read = createBoundedSpoolmanReader({
    origin: ORIGIN,
    context: { farmId: legacy.farmId, serviceId: legacy.serviceId, limit: 50 },
    timeoutMs: 2000,
    fetch: spoolmanFetch('ok', seen),
  })
  await read()
  assert.equal(seen[0]?.['authorization'], undefined)
  // A credential bound to a different origin is never sent.
  const w = world()
  const path = join(w.dir, 'cred.json')
  writeFileSync(
    path,
    JSON.stringify({ origin: 'http://other:1', token: SECRET }),
    {
      mode: 0o600,
    },
  )
  assert.equal(readSpoolmanAuthorization(path, ORIGIN), undefined)
})

// --- Browser flow (mocked session): credentials ride only the RTC session ---
import {
  configureSpoolmanOnConnectors,
  describeSpoolmanConfigurationError,
  validateSpoolmanTargetInput,
  withoutSpoolmanCredentials,
  type SpoolmanOutcome,
  type SpoolmanSession,
} from '../../apps/farm/app/utils/spoolman-onboarding.ts'

function fakeSession(script: {
  prepare: SpoolmanOutcome
  commit?: SpoolmanOutcome
}) {
  const log: string[] = []
  const sent: unknown[] = []
  const session: SpoolmanSession = {
    advertisedRevision: 3,
    async prepare(input) {
      log.push('prepare')
      sent.push(input.target)
      assert.equal(input.expectedRevision, 3)
      return script.prepare
    },
    async commit(input) {
      log.push('commit')
      assert.equal(input.completeInventory, false)
      return script.commit ?? { kind: 'local-committed' }
    },
    async cancel() {
      log.push('cancel')
    },
    close() {
      log.push('close')
    },
  }
  return { session, log, sent }
}

test('form validation rejects URLs with secrets/paths and never echoes input', () => {
  const ok = validateSpoolmanTargetInput({
    origin: ' http://192.168.1.60:7912/ ',
    token: SECRET,
  })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.target.origin, ORIGIN)
  for (const bad of [
    { origin: 'http://u:p@host:1' },
    { origin: 'http://host:1/x?y=1' },
    { origin: 'http://host:1', username: 'only-user' },
    { origin: 'http://host:1', token: SECRET, username: 'a', password: 'b' },
  ]) {
    const result = validateSpoolmanTargetInput(bad)
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
    assert.equal(JSON.stringify(result).includes('http://u:p@host'), false)
  }
  assert.deepEqual(
    withoutSpoolmanCredentials(target({ token: SECRET })).origin,
    ORIGIN,
  )
  assert.equal(
    'token' in withoutSpoolmanCredentials(target({ token: SECRET })),
    false,
  )
  assert.match(
    describeSpoolmanConfigurationError('spoolman-unauthorized') ?? '',
    /recusou as credenciais/,
  )
})

test('page flow reports reachable, unreachable and unauthorized per Connector', async () => {
  const scripts: Record<string, Parameters<typeof fakeSession>[0]> = {
    a: {
      prepare: { kind: 'prepared', targetSha256: 'h', receiptSha256: 'r' },
    },
    b: { prepare: { kind: 'error', code: 'spoolman-unreachable' } },
    c: { prepare: { kind: 'error', code: 'spoolman-unauthorized' } },
    d: { prepare: { kind: 'error', code: 'busy' } },
    e: {
      prepare: { kind: 'prepared', targetSha256: 'h', receiptSha256: 'r' },
      commit: { kind: 'error', code: 'not-available' },
    },
  }
  const sessions = new Map(
    Object.entries(scripts).map(([id, s]) => [id, fakeSession(s)]),
  )
  const reports: Record<string, unknown>[] = []
  const results = await configureSpoolmanOnConnectors({
    target: target({ token: SECRET }),
    agentIds: ['a', 'b', 'c', 'd', 'e'],
    signal: new AbortController().signal,
    openSession: async (id) => sessions.get(id)!.session,
    report: async (r) => {
      reports.push({ ...r })
    },
  })
  assert.deepEqual(
    results.map((r) => [r.agentId, r.status, r.configured]),
    [
      ['a', 'reachable', true],
      ['b', 'unreachable', false],
      ['c', 'unauthorized', false],
      ['d', 'failed', false],
      ['e', 'failed', false],
    ],
  )
  // Server report is non-secret and only exists for definite outcomes.
  assert.deepEqual(
    reports.map((r) => [r.agentId, r.status, r.configured]),
    [
      ['a', 'reachable', true],
      ['b', 'unreachable', false],
      ['c', 'unauthorized', false],
    ],
  )
  for (const report of reports) {
    assert.deepEqual(Object.keys(report).sort(), [
      'agentId',
      'configured',
      'origin',
      'status',
    ])
    assert.equal(JSON.stringify(report).includes(SECRET), false)
  }
  // Failed commit cancels the staged credentials; every session is closed.
  assert.deepEqual(sessions.get('e')!.log, [
    'prepare',
    'commit',
    'cancel',
    'close',
  ])
  for (const { log } of sessions.values()) assert.equal(log.at(-1), 'close')
})

test('an unreachable Connector session does not stop the others', async () => {
  const ok = fakeSession({
    prepare: { kind: 'prepared', targetSha256: 'h', receiptSha256: 'r' },
  })
  const results = await configureSpoolmanOnConnectors({
    target: target(),
    agentIds: ['down', 'up'],
    signal: new AbortController().signal,
    openSession: async (id) => {
      if (id === 'down') throw new Error('offline')
      return ok.session
    },
    report: async () => {},
  })
  assert.deepEqual(
    results.map((r) => r.status),
    ['failed', 'reachable'],
  )
})

test('server schema has no credential column and the migration is paired', () => {
  const up = readFileSync(
    new URL(
      '../../infra/db/migrations/0052_spoolman_farm_settings.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const down = readFileSync(
    new URL(
      '../../infra/db/migrations/0052_spoolman_farm_settings.down.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const sql = up.replace(/^--.*$/gm, '')
  assert.equal(/password|token|secret|credential|api_key/i.test(sql), false)
  assert.match(up, /CREATE TABLE farm\.spoolman_connector_settings/)
  assert.match(down, /DROP TABLE farm\.spoolman_connector_settings/)
  assert.match(down, /DROP ROLE farm_spoolman_settings/)
})
