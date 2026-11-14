import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import { connectorFingerprintFromSpki } from '../../packages/farm-protocol/src/configuration-binding.ts'
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import type { KobraLinkFetch } from '../../packages/connector/src/kobralink/client.ts'
import {
  createProvisioningEngine,
  trustProvisioningAuthority,
} from '../../packages/connector/src/provisioning/index.ts'

// MOCK-ONLY synthetic bridge; filesystem and process semantics are real.
const farm = randomUUID()
const agent = randomUUID()
const BRIDGE = 'http://127.0.0.1:7100'

function bridge() {
  const state = { setup: true, calls: [] as string[], rows: [] as object[] }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const fetch: KobraLinkFetch = async (url, init) => {
    const path = new URL(url).pathname
    state.calls.push(`${init.method} ${path}`)
    if (path === '/api/v1/setup/status')
      return json({ needsSetup: state.setup })
    if (path.startsWith('/api/auth/')) {
      state.setup = false
      return new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'better-auth.session_token=t; HttpOnly; Path=/',
        },
      })
    }
    if (init.method === 'POST') {
      const row = {
        id: 'p1',
        deviceId: 'kx-1',
        ip: '10.0.0.5',
        name: 'Kobra X',
        model: 'Kobra X',
        live: null,
      }
      state.rows.push(row)
      return json(row)
    }
    return json(state.rows)
  }
  return { state, fetch }
}

async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kobra-prov-node-')))
  const runtimeConfigPath = join(dir, 'runtime.json')
  writeFileSync(
    runtimeConfigPath,
    JSON.stringify({
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
      telemetry: {
        endpoint: 'https://farm.example/telemetry',
        audience: 'test',
      },
    }),
    { mode: 0o600 },
  )
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const fingerprint = await connectorFingerprintFromSpki(
    base64url(
      new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
    ),
  )
  const b = bridge()
  const options = {
    stateDirectory: join(dir, 'state'),
    runtime: { runtimeConfigPath, agent_id: agent, farm_id: farm },
    connector: { fingerprint, receiptKey: keys.privateKey },
    authority: trustProvisioningAuthority({
      isCurrent: async () => true,
      acceptsInventoryAck: async () => true,
    }),
    managedBridge: {
      origin: BRIDGE,
      ownership: 'connector-owned-fresh' as const,
    },
    printerNetworks: ['10.0.0.0/24'],
    fetch: b.fetch,
  }
  const target = {
    v: 1,
    protocol: 'config-v1',
    backend: 'kobralink-anycubic',
    model: { family: 'anycubic-kobra-x', provisional: true },
    endpoint: { ipv4: '10.0.0.5', port: 18910 },
    bridge: { kind: 'connector-managed' },
  }
  let n = 0
  const handle = (
    engine: ReturnType<typeof createProvisioningEngine>,
    frame: Record<string, unknown>,
  ) =>
    engine.handle({
      frame: {
        v: 1,
        protocol: 'config-v1',
        request_id: randomUUID(),
        expected_revision: 0,
        ...frame,
      },
      context: {
        account_id: 'account_1',
        role: 'admin',
        farm_id: farm,
        agent_id: agent,
        key_id: '44444444-4444-4444-8444-444444444444',
        credential_jti: '55555555-5555-4555-8555-555555555555',
        transport_id: '11111111-1111-4111-8111-111111111111',
        connector_fingerprint: fingerprint,
        capability_id: randomUUID(),
        admission_nonce: base64url(new Uint8Array(32).fill(++n)),
        action: frame.type,
      },
    })
  return { dir, options, target, handle, bridge: b, runtimeConfigPath }
}

function modes(root: string): string[] {
  const out: string[] = []
  const walk = (path: string) => {
    const stat = statSync(path)
    out.push(
      `${(stat.mode & 0o777).toString(8)} ${stat.isDirectory() ? 'd' : 'f'}`,
    )
    if (stat.isDirectory())
      for (const entry of readdirSync(path)) walk(join(path, entry))
  }
  walk(root)
  return out
}

test('durable files are private, credentials stay in custody, restart replays', async (t) => {
  const s = await setup()
  t.after(() => rmSync(s.dir, { recursive: true, force: true }))
  const op = randomUUID()
  const prepared = await s.handle(createProvisioningEngine(s.options), {
    type: 'prepare',
    operation_id: op,
    target: s.target,
  })
  assert.equal(prepared.type, 'result')
  if (prepared.type !== 'result') return
  const committed = await s.handle(createProvisioningEngine(s.options), {
    type: 'commit',
    operation_id: op,
    target_sha256: await configurationTargetHash(s.target),
    prepared_receipt_sha256: await configurationReceiptHash(prepared.receipt),
  })
  assert.equal(
    committed.type === 'result' && committed.state,
    'local-committed',
  )
  for (const entry of modes(join(s.dir, 'state')))
    assert.ok(entry === '700 d' || entry === '600 f', entry)
  assert.equal(statSync(s.runtimeConfigPath).mode & 0o777, 0o600)
  const custody = JSON.parse(
    readFileSync(join(s.dir, 'state', 'bridge-custody.json'), 'utf8'),
  )
  const password: string = custody.bridges[0].account.password
  assert.ok(password.length >= 32)
  const journal = readdirSync(join(s.dir, 'state', 'operations'))
    .map((f) => readFileSync(join(s.dir, 'state', 'operations', f), 'utf8'))
    .join()
  assert.ok(!journal.includes(password))
  assert.ok(!readFileSync(s.runtimeConfigPath, 'utf8').includes(password))
  // Leftover temp files are never left behind by atomic writes.
  assert.deepEqual(
    readdirSync(join(s.dir, 'state')).filter((f) => f.endsWith('.tmp')),
    [],
  )
  assert.equal(
    s.bridge.state.calls.filter((c) => c === 'POST /api/v1/printers').length,
    1,
  )
})

test('a lock held by a live process means busy; a dead holder is stale', async (t) => {
  const s = await setup()
  t.after(() => rmSync(s.dir, { recursive: true, force: true }))
  const engine = createProvisioningEngine(s.options)
  const lock = join(s.dir, 'state', 'provisioning.lock')
  writeFileSync(lock, `${process.ppid}\n`, { mode: 0o600 })
  const busy = await s.handle(engine, {
    type: 'prepare',
    operation_id: randomUUID(),
    target: s.target,
  })
  assert.equal(busy.type === 'error' && busy.code, 'busy')
  assert.deepEqual(s.bridge.state.calls, [])
  writeFileSync(lock, '2147480000\n', { mode: 0o600 })
  const ok = await s.handle(engine, {
    type: 'prepare',
    operation_id: randomUUID(),
    target: s.target,
  })
  assert.equal(ok.type === 'result' && ok.state, 'prepared')
  assert.ok(!readdirSync(join(s.dir, 'state')).includes('provisioning.lock'))
})

test('symlinked or foreign-mode journal files fail closed', async (t) => {
  const s = await setup()
  t.after(() => rmSync(s.dir, { recursive: true, force: true }))
  const engine = createProvisioningEngine(s.options)
  const state = join(s.dir, 'state', 'state.json')
  const elsewhere = join(s.dir, 'elsewhere.json')
  writeFileSync(elsewhere, '{}', { mode: 0o600 })
  symlinkSync(elsewhere, state)
  const response = await s.handle(engine, {
    type: 'prepare',
    operation_id: randomUUID(),
    target: s.target,
  })
  assert.equal(response.type === 'error' && response.code, 'not-available')
  assert.equal(readFileSync(elsewhere, 'utf8'), '{}')
  assert.deepEqual(s.bridge.state.calls, [])
})

test('a symlinked runtime configuration is never written through', async (t) => {
  const s = await setup()
  t.after(() => rmSync(s.dir, { recursive: true, force: true }))
  const real = join(s.dir, 'real-runtime.json')
  renameSync(s.runtimeConfigPath, real)
  symlinkSync(real, s.runtimeConfigPath)
  const before = readFileSync(real, 'utf8')
  const engine = createProvisioningEngine(s.options)
  const op = randomUUID()
  const prepared = await s.handle(engine, {
    type: 'prepare',
    operation_id: op,
    target: s.target,
  })
  assert.equal(prepared.type === 'error' && prepared.code, 'not-available')
  assert.equal(readFileSync(real, 'utf8'), before)
  assert.equal(
    s.bridge.state.calls.filter((c) => c.startsWith('POST /api/v1/printers'))
      .length,
    0,
  )
})
