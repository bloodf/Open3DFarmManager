import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
import {
  configurationReceiptHash,
  verifyConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import type { ConfigurationResponseFrame } from '../../packages/farm-protocol/src/configuration-frames.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import type { KobraLinkFetch } from '../../packages/connector/src/kobralink/client.ts'
import {
  createProvisioningEngine,
  provisioningRequestFromEvidence,
  trustProvisioningAuthority,
  type ProvisioningEngineOptions,
} from '../../packages/connector/src/provisioning/index.ts'

/*
 * MOCK-ONLY: an original in-memory synthetic bridge that follows the measured
 * management contract (setup/status, sign-up/sign-in cookies, printers list,
 * create, detail, delete). No upstream code, no network, no printer.
 */
const BRIDGE = 'http://127.0.0.1:7100'
const ids = {
  farm: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
  key: '44444444-4444-4444-8444-444444444444',
  jti: '55555555-5555-4555-8555-555555555555',
  transport: '11111111-1111-4111-8111-111111111111',
}
type Printer = { id: string; deviceId: string; ip: string; name: string }
type Fault =
  | 'signup-lost'
  | 'create-lost'
  | 'create-401'
  | 'delete-fail'
  | 'list-fail'
  | 'create-returns-existing'
function syntheticBridge(lan: Record<string, string>) {
  const state = {
    needsSetup: true,
    users: [] as { email: string; password: string }[],
    tokens: new Set<string>(),
    printers: [] as Printer[],
    faults: new Set<Fault>(),
    calls: [] as string[],
    bodies: [] as string[],
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const session = () => {
    const token = randomUUID()
    state.tokens.add(token)
    return new Response('{}', {
      headers: {
        'content-type': 'application/json',
        'set-cookie': `better-auth.session_token=${token}; HttpOnly; Path=/`,
      },
    })
  }
  const authed = (init: RequestInit) => {
    const cookie = String(
      (init.headers as Record<string, string>).Cookie ?? '',
    ).split('=')[1]
    return cookie !== undefined && state.tokens.has(cookie)
  }
  const wire = (p: Printer) => ({
    ...p,
    username: 'mqtt-user-secret',
    model: 'Kobra X',
    live: null,
  })
  const fetch: KobraLinkFetch = async (url, init) => {
    const { pathname } = new URL(url)
    const method = init.method ?? 'GET'
    state.calls.push(`${method} ${pathname}`)
    if (init.body) state.bodies.push(String(init.body))
    if (pathname === '/api/v1/setup/status')
      return json({ needsSetup: state.needsSetup })
    if (pathname === '/api/auth/sign-up/email') {
      if (!state.needsSetup) return json({ message: 'no' }, 403)
      const body = JSON.parse(String(init.body))
      state.users.push({ email: body.email, password: body.password })
      state.needsSetup = false
      if (state.faults.delete('signup-lost')) throw new Error('lost')
      return session()
    }
    if (pathname === '/api/auth/sign-in/email') {
      const body = JSON.parse(String(init.body))
      return state.users.some(
        (u) => u.email === body.email && u.password === body.password,
      )
        ? session()
        : json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, 401)
    }
    if (!authed(init)) return json({ message: 'unauthorized' }, 401)
    if (pathname === '/api/v1/printers' && method === 'GET') {
      if (state.faults.has('list-fail')) return json({}, 503)
      return json(state.printers.map(wire))
    }
    if (pathname === '/api/v1/printers' && method === 'POST') {
      if (state.faults.delete('create-401')) return json({}, 401)
      const first = state.printers[0]
      if (first && state.faults.delete('create-returns-existing'))
        return json(wire(first))
      const body = JSON.parse(String(init.body))
      const deviceId = lan[body.ip]
      if (!deviceId) return json({ message: 'unreachable' }, 503)
      const created = {
        id: `p${state.printers.length + 1}`,
        deviceId,
        ip: body.ip,
        name: body.name,
      }
      state.printers.push(created)
      if (state.faults.delete('create-lost')) throw new Error('lost')
      return json(wire(created))
    }
    const match = /^\/api\/v1\/printers\/([A-Za-z0-9_-]+)$/.exec(pathname)
    const found = state.printers.find((p) => p.id === match?.[1])
    if (match && !found) return json({ message: 'missing' }, 404)
    if (match && found && method === 'GET') return json(wire(found))
    if (match && found && method === 'DELETE') {
      if (state.faults.has('delete-fail')) throw new Error('lost')
      state.printers = state.printers.filter((p) => p !== found)
      return new Response(null, { status: 204 })
    }
    return json({}, 404)
  }
  return { state, fetch }
}

const realFetch = globalThis.fetch
let networkAttempts = 0
beforeEach(() => {
  networkAttempts = 0
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error('real network forbidden')
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  expect(networkAttempts).toBe(0)
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function fixture(
  lan: Record<string, string> = {
    '192.168.1.50': 'kx-0001',
    '192.168.1.51': 'kx-0002',
  },
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kobra-prov-')))
  dirs.push(dir)
  const runtimePath = join(dir, 'runtime.json')
  const moonraker = {
    assignment_id: randomUUID(),
    farm_id: ids.farm,
    agent_id: ids.agent,
    printer_key: 'voron',
    moonraker_origin: 'http://127.0.0.1:7125',
  }
  writeFileSync(
    runtimePath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: ['http://127.0.0.1:7125'],
        printers: [{ printerKey: 'voron', origin: 'http://127.0.0.1:7125' }],
      },
      assignments: [moonraker],
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
  const spki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
  )
  const fingerprint = await connectorFingerprintFromSpki(spki)
  const bridge = syntheticBridge(lan)
  const authority = { current: true, acks: 0, checks: 0, ackOk: true }
  const trusted = trustProvisioningAuthority({
    async isCurrent() {
      authority.checks++
      return authority.current
    },
    async acceptsInventoryAck() {
      authority.acks++
      return authority.ackOk
    },
  })
  const events: string[] = []
  let crashAt: { stage: string; nth: number } | null = null
  const options: ProvisioningEngineOptions = {
    stateDirectory: join(dir, 'state'),
    runtime: {
      runtimeConfigPath: runtimePath,
      agent_id: ids.agent,
      farm_id: ids.farm,
    },
    connector: { fingerprint, receiptKey: keys.privateKey },
    authority: trusted,
    managedBridge: { origin: BRIDGE, ownership: 'connector-owned-fresh' },
    printerNetworks: ['192.168.1.0/24'],
    fetch: bridge.fetch,
    onDurableStage(stage) {
      events.push(stage)
      if (crashAt && stage === crashAt.stage && --crashAt.nth === 0) {
        crashAt = null
        throw new Error('simulated crash')
      }
    },
  }
  const engine = () => createProvisioningEngine(options)
  let capability = 0
  const context = (
    action: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    account_id: 'account_1',
    role: 'owner',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    credential_jti: ids.jti,
    transport_id: ids.transport,
    connector_fingerprint: fingerprint,
    capability_id: randomUUID(),
    admission_nonce: base64url(new Uint8Array(32).fill(++capability % 250)),
    action,
    ...overrides,
  })
  const target = (
    ip = '192.168.1.50',
    extra: Record<string, unknown> = {},
  ) => ({
    v: 1,
    protocol: 'config-v1',
    backend: 'kobralink-anycubic',
    model: { family: 'anycubic-kobra-x', provisional: true },
    endpoint: { ipv4: ip, port: 18910 },
    bridge: { kind: 'connector-managed' },
    ...extra,
  })
  const frame = (
    type: string,
    operation_id: string,
    extra: Record<string, unknown>,
  ) => ({
    v: 1,
    protocol: 'config-v1',
    type,
    request_id: randomUUID(),
    operation_id,
    expected_revision: 0,
    ...extra,
  })
  const responses: ConfigurationResponseFrame[] = []
  const call = async (
    e: ReturnType<typeof engine>,
    f: Record<string, unknown>,
    ctx: Record<string, unknown> = {},
  ) => {
    const response = await e.handle({
      frame: f,
      context: context(String(f.type), ctx),
    })
    responses.push(response)
    return response
  }
  const prepare = (
    e: ReturnType<typeof engine>,
    op: string,
    t = target(),
    rev = 0,
  ) => call(e, frame('prepare', op, { target: t, expected_revision: rev }))
  const commit = async (
    e: ReturnType<typeof engine>,
    op: string,
    prepared: ConfigurationResponseFrame,
    t = target(),
    rev = 0,
  ) => {
    if (prepared.type !== 'result') throw new Error('not prepared')
    return call(
      e,
      frame('commit', op, {
        expected_revision: rev,
        target_sha256: await configurationTargetHash(t),
        prepared_receipt_sha256: await configurationReceiptHash(
          prepared.receipt,
        ),
      }),
    )
  }
  const simple = async (
    e: ReturnType<typeof engine>,
    type: 'status' | 'cancel',
    op: string,
    t = target(),
    rev = 0,
    ctx: Record<string, unknown> = {},
  ) =>
    call(
      e,
      frame(type, op, {
        expected_revision: rev,
        target_sha256: await configurationTargetHash(t),
      }),
      ctx,
    )
  const runtime = () => JSON.parse(readFileSync(runtimePath, 'utf8'))
  const stateFiles = () => {
    const root = join(dir, 'state')
    const ops = readdirSync(join(root, 'operations')).map((f) =>
      readFileSync(join(root, 'operations', f), 'utf8'),
    )
    return [readFileSync(join(root, 'state.json'), 'utf8'), ...ops].join('\n')
  }
  const custody = () =>
    JSON.parse(readFileSync(join(dir, 'state', 'bridge-custody.json'), 'utf8'))
  return {
    dir,
    keys,
    bridge,
    authority,
    events,
    options,
    engine,
    context,
    target,
    frame,
    call,
    prepare,
    commit,
    simple,
    runtime,
    stateFiles,
    custody,
    responses,
    runtimePath,
    crash(stage: string, nth = 1) {
      crashAt = { stage, nth }
    },
    secrets() {
      return custody().bridges.map(
        (b: { account: { password: string } }) => b.account.password,
      )
    },
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const expectNoSecrets = (f: Fixture) => {
  const secrets = [...f.secrets(), 'mqtt-user-secret']
  const visible = JSON.stringify(f.responses) + f.stateFiles()
  for (const secret of secrets) expect(visible).not.toContain(secret)
}
const posts = (f: Fixture) =>
  f.bridge.state.calls.filter((c) => c === 'POST /api/v1/printers').length
const deletes = (f: Fixture) =>
  f.bridge.state.calls.filter((c) => c.startsWith('DELETE')).length

describe('KobraLink provisioning engine (synthetic bridge, mock-only)', () => {
  it('onboards an unknown Kobra X end to end with one interface', async () => {
    const f = await fixture()
    const e = f.engine()
    const op = randomUUID()
    const prepared = await f.prepare(e, op)
    expect(prepared).toMatchObject({ type: 'result', state: 'prepared' })
    if (prepared.type !== 'result') throw new Error()
    // Observed identity returned for user confirmation; no invented id.
    expect(prepared.receipt.observed).toEqual({
      device_id: 'kx-0001',
      model: 'Kobra X',
      firmware: { status: 'unknown' },
      support: 'unqualified',
    })
    expect(prepared.receipt.target.target_sha256).toBe(
      await configurationTargetHash(f.target()),
    )
    expect(
      await verifyConfigurationReceipt(prepared.receipt, f.keys.publicKey),
    ).toBe(true)
    // Bridge machine account: independent, persisted, private.
    const custody = f.custody()
    expect(custody.bridges).toHaveLength(1)
    expect(custody.bridges[0]).toMatchObject({
      state: 'established',
      ownership: 'connector-owned',
    })
    expect(
      statSync(join(f.dir, 'state', 'bridge-custody.json')).mode & 0o777,
    ).toBe(0o600)
    // Fixed upstream port: the create body carries only ip and name.
    const createBody = f.bridge.state.bodies.find((b) => b.includes('"ip"'))
    expect(JSON.parse(createBody ?? '{}')).toEqual({
      ip: '192.168.1.50',
      name: 'Kobra X',
    })

    const committed = await f.commit(e, op, prepared)
    expect(committed).toMatchObject({
      type: 'result',
      state: 'local-committed',
    })
    if (committed.type !== 'result') throw new Error()
    expect(committed.receipt.committed_revision).toBe(1)
    expect(committed.receipt.prior_receipt_sha256).toBe(
      await configurationReceiptHash(prepared.receipt),
    )
    const runtime = f.runtime()
    expect(runtime.version).toBe(2)
    expect(runtime.assignments).toHaveLength(2)
    expect(runtime.assignments[0].printer_key).toBe('voron')
    expect(runtime.collection.printers).toEqual([
      { printerKey: 'voron', origin: 'http://127.0.0.1:7125' },
    ])
    expect(runtime.collection.kobralink.printers[0]).toMatchObject({
      bridgeInstance: custody.bridges[0].bridge_instance_id,
      deviceId: 'kx-0001',
      id: 'p1',
      revision: 1,
    })
    const loaded = readAgentRuntimeConfig(f.runtimePath, {
      agent_id: ids.agent,
      farm_id: ids.farm,
    })
    expect(loaded.assignments).toHaveLength(2)
    expect(JSON.stringify(runtime)).not.toContain(f.secrets()[0])

    expect(await f.simple(e, 'status', op)).toMatchObject({
      state: 'local-committed',
    })
    const pending = await e.pendingInventoryConfirmations()
    expect(pending.map((p) => p.operation_id)).toEqual([op])
    const ack = {
      operation_id: op,
      local_committed_receipt_sha256: await configurationReceiptHash(
        committed.receipt,
      ),
      committed_revision: 1,
    }
    const confirmed = await e.confirmInventory(ack)
    expect(confirmed).toMatchObject({
      ok: true,
      receipt: { phase: 'inventory-confirmed' },
    })
    expect(await e.confirmInventory(ack)).toEqual(confirmed)
    expect(f.authority.acks).toBe(1)
    expect(await e.pendingInventoryConfirmations()).toEqual([])
    expect(posts(f)).toBe(1)
    expectNoSecrets(f)
  })

  it('rejects browser-selected ports and addresses outside local policy before any call', async () => {
    const f = await fixture()
    const e = f.engine()
    for (const t of [
      f.target('192.168.1.50', {
        endpoint: { ipv4: '192.168.1.50', port: 7125 },
      }),
      f.target('192.168.2.50'),
      f.target('127.0.0.1'),
      f.target('192.168.1.255'),
    ])
      expect(await f.prepare(e, randomUUID(), t)).toMatchObject({
        code: 'invalid-request',
      })
    expect(
      await e.handle({ frame: { type: 'prepare', url: BRIDGE }, context: {} }),
    ).toMatchObject({
      code: 'invalid-request',
      request_id: null,
    })
    expect(f.bridge.state.calls).toEqual([])
  })

  it('never takes over an initialized service without local custody', async () => {
    const f = await fixture()
    f.bridge.state.needsSetup = false
    const e = f.engine()
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'bridge-unavailable',
    })
    expect(f.bridge.state.calls).toEqual(['GET /api/v1/setup/status'])
    expect(readdirSync(join(f.dir, 'state'))).not.toContain(
      'bridge-custody.json',
    )
  })

  it('persists machine credentials before signup and reconciles a lost signup response', async () => {
    const f = await fixture()
    f.bridge.state.faults.add('signup-lost')
    const e = f.engine()
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'bridge-unavailable',
    })
    const pending = f.custody().bridges[0]
    expect(pending.state).toBe('signup-pending')
    expect(f.bridge.state.users).toEqual([
      { email: pending.account.email, password: pending.account.password },
    ])
    // New process: signup is not repeated; sign-in proves our own account.
    const prepared = await f.prepare(f.engine(), randomUUID())
    expect(prepared).toMatchObject({ state: 'prepared' })
    const signups = f.bridge.state.calls.filter((c) =>
      c.endsWith('sign-up/email'),
    )
    expect(signups).toHaveLength(1)
    expect(f.custody().bridges[0]).toMatchObject({
      state: 'established',
      account: pending.account,
    })
    expectNoSecrets(f)
  })

  it('marks a pending bridge initialized by someone else as conflict and never resets it', async () => {
    const f = await fixture()
    f.bridge.state.faults.add('signup-lost')
    const e = f.engine()
    await f.prepare(e, randomUUID())
    f.bridge.state.users = [
      { email: 'other@example.test', password: 'other-password' },
    ]
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'bridge-unavailable',
    })
    expect(f.custody().bridges[0].state).toBe('conflict')
    const before = f.bridge.state.calls.length
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'bridge-unavailable',
    })
    expect(f.bridge.state.calls.length).toBe(before)
    expect(
      f.bridge.state.calls.filter((c) => c.endsWith('sign-up/email')),
    ).toHaveLength(1)
  })

  it('turns a lost create response into recovery without resending or deleting', async () => {
    const f = await fixture()
    f.bridge.state.faults.add('create-lost')
    const op = randomUUID()
    expect(await f.prepare(f.engine(), op)).toMatchObject({
      type: 'unknown',
      reason: 'timeout-after-write',
    })
    const restarted = f.engine()
    expect(await f.simple(restarted, 'status', op)).toMatchObject({
      type: 'unknown',
      reason: 'timeout-after-write',
    })
    expect(await f.prepare(restarted, op)).toMatchObject({
      reason: 'timeout-after-write',
    })
    // Another operation is blocked until the ambiguous one is acknowledged.
    expect(await f.prepare(restarted, randomUUID())).toMatchObject({
      code: 'busy',
    })
    expect(await f.simple(restarted, 'cancel', op)).toMatchObject({
      reason: 'cancel-acknowledged',
    })
    expect(posts(f)).toBe(1)
    expect(deletes(f)).toBe(0)
    // A fresh operation observes the row as preexisting: no duplicate, no deletion on cancel.
    const next = randomUUID()
    const prepared = await f.prepare(restarted, next)
    expect(prepared).toMatchObject({ state: 'prepared' })
    expect(await f.simple(restarted, 'cancel', next)).toMatchObject({
      reason: 'cancel-acknowledged',
    })
    expect(posts(f)).toBe(1)
    expect(deletes(f)).toBe(0)
    expect(f.bridge.state.printers).toHaveLength(1)
  })

  it('never converts a crash around the create into success', async () => {
    for (const nth of [1, 2]) {
      const f = await fixture()
      // nth=1: crash after create-pending is durable, before the write.
      // nth=2: upstream create succeeded, local journal update failed.
      f.crash('create-pending', nth)
      const op = randomUUID()
      expect(await f.prepare(f.engine(), op)).toMatchObject({
        code: 'not-available',
      })
      const status = await f.simple(f.engine(), 'status', op)
      expect(status).toMatchObject({ type: 'unknown' })
      expect(status.type === 'result').toBe(false)
      expect(posts(f)).toBe(nth - 1)
      expect(deletes(f)).toBe(0)
    }
  })

  it('replays a repeated operation after restart without new effects', async () => {
    const f = await fixture()
    const op = randomUUID()
    const first = await f.prepare(f.engine(), op)
    const calls = f.bridge.state.calls.length
    const again = await f.prepare(f.engine(), op)
    expect(
      again.type === 'result' && first.type === 'result' && again.receipt,
    ).toEqual(first.type === 'result' && first.receipt)
    expect(f.bridge.state.calls.length).toBe(calls)
  })

  it('rejects conflicting request ids, targets, revisions and concurrent operations', async () => {
    const f = await fixture()
    const e = f.engine()
    const op = randomUUID()
    const prepareFrame = f.frame('prepare', op, { target: f.target() })
    await f.call(e, prepareFrame)
    expect(
      await f.call(e, { ...prepareFrame, expected_revision: 1 }),
    ).toMatchObject({ code: 'invalid-request' })
    expect(await f.prepare(e, op, f.target('192.168.1.51'))).toMatchObject({
      code: 'identity-conflict',
    })
    expect(await f.prepare(e, op, f.target(), 3)).toMatchObject({
      code: 'revision-conflict',
    })
    expect(
      await f.prepare(e, randomUUID(), f.target('192.168.1.51')),
    ).toMatchObject({
      code: 'busy',
    })
    expect(
      await f.simple(e, 'status', op, f.target('192.168.1.51')),
    ).toMatchObject({
      code: 'identity-conflict',
    })
    const prepared = await f.simple(e, 'status', op)
    expect(await f.commit(e, op, prepared, f.target(), 5)).toMatchObject({
      code: 'revision-conflict',
    })
    await f.simple(e, 'cancel', op)
    expect(
      await f.prepare(e, randomUUID(), f.target('192.168.1.51'), 2),
    ).toMatchObject({
      code: 'revision-conflict',
    })
  })

  it('rejects a commit bound to another prepared receipt', async () => {
    const f = await fixture()
    const e = f.engine()
    const op = randomUUID()
    const prepared = await f.prepare(e, op)
    if (prepared.type !== 'result') throw new Error()
    const forged = {
      ...prepared,
      receipt: { ...prepared.receipt, receipt_id: randomUUID() },
    }
    expect(await f.commit(e, op, forged)).toMatchObject({
      code: 'identity-conflict',
    })
    expect(f.runtime().version).toBe(1)
  })

  it('compensates only a row it created when the expected device differs', async () => {
    const f = await fixture()
    const e = f.engine()
    const op = randomUUID()
    const t = f.target('192.168.1.50', { device_id: 'kx-9999' })
    expect(await f.prepare(e, op, t)).toMatchObject({
      code: 'identity-conflict',
    })
    expect(posts(f)).toBe(1)
    expect(deletes(f)).toBe(1)
    expect(f.bridge.state.printers).toEqual([])
  })

  it('never claims or deletes a row that existed before its create', async () => {
    const f = await fixture()
    const e = f.engine()
    f.bridge.state.faults.add('create-returns-existing')
    f.bridge.state.printers.push({
      id: 'foreign',
      deviceId: 'kx-0001',
      ip: '192.168.1.70',
      name: 'x',
    })
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'identity-conflict',
    })
    expect(deletes(f)).toBe(0)
    expect(f.bridge.state.printers.map((p) => p.id)).toEqual(['foreign'])
  })

  it('refuses unauthorized create without recovery ambiguity', async () => {
    const f = await fixture()
    f.bridge.state.faults.add('create-401')
    expect(await f.prepare(f.engine(), randomUUID())).toMatchObject({
      code: 'bridge-unavailable',
    })
    expect(f.bridge.state.printers).toEqual([])
  })

  it('records a failed compensation as recovery instead of retrying blindly', async () => {
    const f = await fixture()
    f.bridge.state.faults.add('delete-fail')
    const e = f.engine()
    const op = randomUUID()
    const prepared = await f.prepare(e, op)
    expect(prepared).toMatchObject({ state: 'prepared' })
    const cancelled = await f.simple(e, 'cancel', op)
    expect(cancelled).toMatchObject({
      type: 'result',
      state: 'recovery-required',
    })
    if (cancelled.type !== 'result') throw new Error()
    expect(cancelled.receipt.recovery_reason).toBe('rollback-failed')
    expect(deletes(f)).toBe(1)
    expect(await f.simple(e, 'cancel', op)).toMatchObject({
      reason: 'cancel-acknowledged',
    })
    expect(deletes(f)).toBe(1)
  })

  it('cancels an owned prepared printer and leaves preexisting rows untouched', async () => {
    const f = await fixture()
    const e = f.engine()
    f.bridge.state.needsSetup = true
    const first = randomUUID()
    await f.prepare(e, first, f.target('192.168.1.51'))
    await f.simple(e, 'cancel', first, f.target('192.168.1.51'))
    expect(f.bridge.state.printers).toEqual([])
    // Preexisting row (created outside this operation) is observed, never deleted.
    f.bridge.state.printers.push({
      id: 'foreign',
      deviceId: 'kx-0001',
      ip: '192.168.1.50',
      name: 'x',
    })
    const second = randomUUID()
    expect(await f.prepare(e, second)).toMatchObject({ state: 'prepared' })
    await f.simple(e, 'cancel', second)
    expect(f.bridge.state.printers.map((p) => p.id)).toEqual(['foreign'])
    expect(deletes(f)).toBe(1)
  })

  it('refuses expected devices found at another address or ambiguous addresses', async () => {
    const f = await fixture()
    const e = f.engine()
    await f
      .prepare(e, randomUUID(), f.target('192.168.1.51'))
      .then(async (r) => {
        if (r.type === 'result')
          await f.simple(e, 'cancel', r.operation_id, f.target('192.168.1.51'))
      })
    f.bridge.state.printers = [
      { id: 'a', deviceId: 'kx-0001', ip: '192.168.1.60', name: 'a' },
    ]
    const posted = posts(f)
    expect(
      await f.prepare(
        e,
        randomUUID(),
        f.target('192.168.1.50', { device_id: 'kx-0001' }),
      ),
    ).toMatchObject({ code: 'identity-conflict' })
    f.bridge.state.printers.push(
      { id: 'b', deviceId: 'kx-7', ip: '192.168.1.52', name: 'b' },
      { id: 'c', deviceId: 'kx-8', ip: '192.168.1.52', name: 'c' },
    )
    expect(
      await f.prepare(e, randomUUID(), f.target('192.168.1.52')),
    ).toMatchObject({
      code: 'identity-conflict',
    })
    expect(posts(f)).toBe(posted)
  })

  it('requires current authority before every action and mutation', async () => {
    const f = await fixture()
    const e = f.engine()
    f.authority.current = false
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'capability-rejected',
    })
    expect(f.bridge.state.calls).toEqual([])
    expect(readdirSync(join(f.dir, 'state', 'operations'))).toEqual([])
    f.authority.current = true
    const op = randomUUID()
    const prepared = await f.prepare(e, op)
    f.authority.current = false
    expect(await f.commit(e, op, prepared)).toMatchObject({
      code: 'capability-rejected',
    })
    expect(await f.simple(e, 'status', op)).toMatchObject({
      code: 'capability-rejected',
    })
    expect(await f.simple(e, 'cancel', op)).toMatchObject({
      code: 'capability-rejected',
    })
    expect(f.runtime().version).toBe(1)
    expect(deletes(f)).toBe(0)
    // Revoked between admission and the create write: nothing is created.
    f.authority.current = true
    await f.simple(e, 'cancel', op)
    let checks = 0
    const flaky = createProvisioningEngine({
      ...f.options,
      authority: trustProvisioningAuthority({
        isCurrent: async () => ++checks < 2,
        acceptsInventoryAck: async () => false,
      }),
    })
    const before = posts(f)
    expect(
      await f.prepare(flaky, randomUUID(), f.target('192.168.1.51'), 0),
    ).toMatchObject({
      code: 'capability-rejected',
    })
    expect(posts(f)).toBe(before)
  })

  it('binds operations to account, farm, agent, key, Connector and single-use capability', async () => {
    const f = await fixture()
    const e = f.engine()
    const op = randomUUID()
    await f.prepare(e, op)
    const hash = await configurationTargetHash(f.target())
    const status = f.frame('status', op, { target_sha256: hash })
    for (const ctx of [
      { account_id: 'account_2' },
      { key_id: randomUUID() },
      { agent_id: randomUUID() },
      { farm_id: randomUUID() },
      { connector_fingerprint: 'SHA256:' + 'A'.repeat(43) },
      { role: 'viewer' },
      { action: 'commit' },
    ])
      expect(await f.call(e, status, ctx)).toMatchObject({
        code: 'capability-rejected',
      })
    const reused = f.context('status')
    expect(await e.handle({ frame: status, context: reused })).toMatchObject({
      state: 'prepared',
    })
    expect(
      await e.handle({
        frame: { ...status, request_id: randomUUID() },
        context: reused,
      }),
    ).toMatchObject({ code: 'capability-rejected' })
    expect(
      provisioningRequestFromEvidence({ ok: false, reason: 'malformed' }),
    ).toBeNull()
  })

  it('reconciles a commit interrupted before or after the runtime write', async () => {
    const f = await fixture()
    const op = randomUUID()
    const prepared = await f.prepare(f.engine(), op)
    f.crash('committing')
    expect(await f.commit(f.engine(), op, prepared)).toMatchObject({
      code: 'not-available',
    })
    expect(f.runtime().version).toBe(1)
    expect(await f.simple(f.engine(), 'status', op)).toMatchObject({
      state: 'prepared',
    })
    expect(readdirSync(join(f.dir, 'state', 'credentials'))).toEqual([])
    f.crash('local-committed')
    expect(await f.commit(f.engine(), op, prepared)).toMatchObject({
      code: 'not-available',
    })
    const restarted = f.engine()
    expect(await f.simple(restarted, 'status', op)).toMatchObject({
      state: 'local-committed',
    })
    expect(f.runtime().assignments).toHaveLength(2)
    // Revision advanced exactly once; the next operation uses it.
    expect(
      await f.prepare(restarted, randomUUID(), f.target('192.168.1.51'), 1),
    ).toMatchObject({ state: 'prepared' })
  })

  it('keeps an unacknowledged inventory confirmation pending across restart', async () => {
    const f = await fixture()
    const op = randomUUID()
    const e = f.engine()
    const committed = await f.commit(e, op, await f.prepare(e, op))
    if (committed.type !== 'result') throw new Error()
    const restarted = f.engine()
    expect(
      (await restarted.pendingInventoryConfirmations())[0]?.receipt,
    ).toEqual(committed.receipt)
    const hash = await configurationReceiptHash(committed.receipt)
    expect(
      await restarted.confirmInventory({
        operation_id: op,
        local_committed_receipt_sha256: hash,
        committed_revision: 2,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' })
    f.authority.ackOk = false
    expect(
      await restarted.confirmInventory({
        operation_id: op,
        local_committed_receipt_sha256: hash,
        committed_revision: 1,
      }),
    ).toEqual({ ok: false, reason: 'rejected' })
    f.authority.ackOk = true
    expect(
      await restarted.confirmInventory({
        operation_id: op,
        local_committed_receipt_sha256: hash,
        committed_revision: 1,
      }),
    ).toMatchObject({ ok: true })
    expect(await f.simple(restarted, 'cancel', op)).toMatchObject({
      code: 'invalid-request',
    })
  })

  it('keeps independent devices isolated and refuses rebinding a bound device', async () => {
    const f = await fixture()
    const e = f.engine()
    const a = randomUUID()
    await f.commit(e, a, await f.prepare(e, a))
    const b = randomUUID()
    const tb = f.target('192.168.1.51')
    const committed = await f.commit(e, b, await f.prepare(e, b, tb, 1), tb, 1)
    expect(committed).toMatchObject({ state: 'local-committed' })
    const runtime = f.runtime()
    const printers = runtime.collection.kobralink.printers
    expect(printers.map((p: { deviceId: string }) => p.deviceId)).toEqual([
      'kx-0001',
      'kx-0002',
    ])
    expect(
      new Set(printers.map((p: { credentialFile: string }) => p.credentialFile))
        .size,
    ).toBe(2)
    expect(runtime.assignments).toHaveLength(3)
    // Already bound device cannot be onboarded again or rebound.
    expect(await f.prepare(e, randomUUID(), f.target(), 2)).toMatchObject({
      code: 'identity-conflict',
    })
    expect(
      readAgentRuntimeConfig(f.runtimePath, {
        agent_id: ids.agent,
        farm_id: ids.farm,
      }).assignments,
    ).toHaveLength(3)
  })

  it('rejects unsafe state directories and untrusted adapters', async () => {
    const f = await fixture()
    const link = join(f.dir, 'link')
    const real = join(f.dir, 'real')
    mkdirSync(real, { mode: 0o700 })
    symlinkSync(real, link)
    expect(() =>
      createProvisioningEngine({ ...f.options, stateDirectory: link }),
    ).toThrow()
    expect(() =>
      createProvisioningEngine({
        ...f.options,
        stateDirectory: join(link, 'nested'),
      }),
    ).toThrow()
    const open = join(f.dir, 'open')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    expect(() =>
      createProvisioningEngine({ ...f.options, stateDirectory: open }),
    ).toThrow()
    expect(() =>
      createProvisioningEngine({ ...f.options, stateDirectory: 'relative' }),
    ).toThrow()
    expect(() =>
      createProvisioningEngine({
        ...f.options,
        authority: {
          isCurrent: async () => true,
          acceptsInventoryAck: async () => true,
        },
      }),
    ).toThrow('trusted')
    expect(() =>
      createProvisioningEngine({
        ...f.options,
        printerNetworks: ['8.8.8.0/24'],
      }),
    ).toThrow()
    expect(() =>
      createProvisioningEngine({
        ...f.options,
        managedBridge: {
          origin: 'http://example.com',
          ownership: 'connector-owned-fresh',
        },
      }),
    ).toThrow()
  })

  it('fails closed on a tampered journal without leaking details', async () => {
    const f = await fixture()
    const e = f.engine()
    const op = randomUUID()
    await f.prepare(e, op)
    const file = join(f.dir, 'state', 'operations', `${op}.json`)
    chmodSync(file, 0o644)
    const status = await f.simple(e, 'status', op)
    expect(status).toEqual({
      v: 1,
      protocol: 'config-v1',
      type: 'error',
      request_id: expect.any(String),
      code: 'not-available',
    })
    expectNoSecrets(f)
  })

  it('handles unknown operations and unavailable existing bridges honestly', async () => {
    const f = await fixture()
    const e = f.engine()
    expect(await f.simple(e, 'status', randomUUID())).toMatchObject({
      reason: 'no-durable-record',
    })
    expect(
      await f.prepare(
        e,
        randomUUID(),
        f.target('192.168.1.50', {
          bridge: { kind: 'existing', bridge_instance_id: 'bridge-unknown' },
        }),
      ),
    ).toMatchObject({ code: 'not-available' })
    const noManaged = createProvisioningEngine({
      ...f.options,
      managedBridge: null,
    })
    expect(await f.prepare(noManaged, randomUUID())).toMatchObject({
      code: 'not-available',
    })
    f.bridge.state.faults.add('list-fail')
    expect(await f.prepare(e, randomUUID())).toMatchObject({
      code: 'bridge-unavailable',
    })
    expect(
      f.bridge.state.calls.some(
        (c) => c.includes('reconnect') || c.includes('refresh'),
      ),
    ).toBe(false)
  })

  it('exposes no arbitrary command, power, upload or camera method', async () => {
    const f = await fixture()
    const e = f.engine()
    expect(Object.keys(e).sort()).toEqual([
      'confirmInventory',
      'handle',
      'pendingInventoryConfirmations',
    ])
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false)
  })
})
