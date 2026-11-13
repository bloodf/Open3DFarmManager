import { beforeAll, expect, test } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  CredentialProofCompletion,
  CredentialProofRequest,
  credentialProofPayload,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import {
  connectorFingerprintFromSpki,
  encodeConfigurationSessionProof,
  signConfigurationSessionProof,
} from '../../packages/farm-protocol/src/configuration-binding.ts'
import {
  encodeConfigurationAdmissionProof,
  signConfigurationAdmissionProof,
  verifyConfigurationAuthorityEvidence,
} from '../../packages/farm-protocol/src/configuration-capability.ts'
import {
  configurationReceiptHash,
  encodeConfigurationReceipt,
  signConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
// Real login/sealing path; persistence is replaced at its public boundary.
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { SessionDecision } from '../../apps/farm/server/utils/auth/session-contract.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import type {
  ConfigurationAuthority,
  ConfigurationAuthorityStore,
  ConfigurationChallengeRecord,
  ConfigurationOperationRecord,
  ConfigurationReceiptRecord,
} from '../../apps/farm/server/services/configuration-authority-contract.ts'
import { createConfigurationAuthorityService } from '../../apps/farm/server/services/configuration-authority.ts'
import { createConfigurationRegistrationService } from '../../apps/farm/server/services/configuration-receipt-registration.ts'
import { ConfigurationSignallingCoordinator } from '../../apps/farm/server/services/configuration-signalling-coordinator.ts'
import { createConfigurationSocketSession } from '../../apps/farm/server/services/configuration-signalling-session.ts'
import {
  ConfigurationSignallingRuntime,
  configurationSocketHooks,
} from '../../apps/farm/server/services/configuration-signalling-runtime.ts'
import {
  decodeConfigurationSignallingClientFrame,
  decodeConfigurationSignallingServerFrame,
  encodeConfigurationSignallingClientFrame,
} from '../../apps/farm/server/services/configuration-signalling-wire.ts'
import {
  configurationAuthorityRequest,
  configurationBootstrapRequest,
  configurationReceiptRequest,
  readConfigurationBody,
  type ConfigurationHttpRuntime,
} from '../../apps/farm/server/services/configuration-http.ts'
import configurationMiddleware from '../../apps/farm/server/middleware/10.configuration.ts'
import {
  configurationHttpRuntime,
  configurationSignallingRuntime,
  installConfigurationRuntime,
} from '../../apps/farm/server/utils/configuration/runtime.ts'

const origin = 'https://farm.example.invalid'
const audience = 'open3dfarm:configuration'
const credentialAudience = 'open3dfarm:connector'
const ids = {
  farm: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
  key: '44444444-4444-4444-8444-444444444444',
  jti: '55555555-5555-4555-8555-555555555555',
}
const sessionRecordId = 'configuration-http-session'
const token = 'synthetic-connector-credential'
const digest = () => randomBytes(32).toString('base64url')
const sdp = (seed: string) =>
  `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(seed).join(':')}\r\na=setup:actpass\r\n`
const target = {
  v: 1,
  protocol: 'config-v1',
  backend: 'kobralink-anycubic',
  model: { family: 'anycubic-kobra-x', provisional: true },
  endpoint: { ipv4: '192.168.77.50', port: 18910 },
  device_id: 'kobra-x-synthetic-1',
  bridge: { kind: 'connector-managed' },
}
const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-configuration-test-secret-32-chars',
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
} satisfies AuthRuntime['cookie']
let cookie = ''

function authFixture() {
  const state: { decision: SessionDecision; quota: boolean } = {
    decision: { ok: true, accountId: 'account-owner', touchAt: Date.now() },
    quota: true,
  }
  const limits: string[] = []
  const auth: AuthRuntime = {
    origin,
    cookie: cookieConfig,
    idleTimeoutMs: 60000,
    lifetimeMs: 3600000,
    sessions: {
      async authorizeAndTouch(id) {
        expect(id).toBe(sessionRecordId)
        return state.decision
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit(kind, key) {
        limits.push(`${kind}:${key}`)
        return state.quota
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
  }
  return { auth, state, limits }
}
beforeAll(async () => {
  const { auth } = authFixture()
  const passwordHash = await hashPassword('synthetic-test-password')
  auth.credentials.find = async () => ({
    accountId: 'account-owner',
    passwordHash,
    credentialVersion: '1',
    sessionVersion: '1',
  })
  auth.credentials.issue = async () => sessionRecordId
  const event = {
    req: new Request(origin + '/api/auth/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'owner',
        password: 'synthetic-test-password',
      }),
    }),
    res: { headers: new Headers() },
  }
  await login(event, auth)
  cookie = event.res.headers.getSetCookie().at(-1)?.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
})

/** Synthetic store. One transaction at a time; a rejection restores every map. */
function memoryStore() {
  const state = {
    authority: null as unknown,
    operations: new Map<string, ConfigurationOperationRecord>(),
    challenges: new Map<string, ConfigurationChallengeRecord>(),
    receipts: new Map<string, ConfigurationReceiptRecord>(),
    assignments: new Map<string, string>(),
  }
  let chain: Promise<unknown> = Promise.resolve()
  const store: ConfigurationAuthorityStore = {
    transaction(scope, work) {
      const run = () => {
        const a = state.authority as ConfigurationAuthority | null
        return work({
          authority:
            a &&
            scope.sessionRecordId === sessionRecordId &&
            scope.farmId === a.farm_id &&
            scope.agentId === a.agent_id &&
            scope.keyId === a.key_id
              ? structuredClone(a)
              : null,
          observedAt: Date.now(),
          operation: async (id) => state.operations.get(id) ?? null,
          createOperation: async (record) =>
            !state.operations.has(record.operation_id) &&
            !!state.operations.set(record.operation_id, record),
          pinCommit: async (id, commit) => {
            const op = state.operations.get(id)
            if (!op || op.commit_sha256 !== null) return false
            state.operations.set(id, { ...op, commit_sha256: commit })
            return true
          },
          insertChallenge: async (record) =>
            !state.challenges.has(record.challenge.challenge_id) &&
            !!state.challenges.set(record.challenge.challenge_id, record),
          consumeChallenge: async (id) => {
            const record = state.challenges.get(id) ?? null
            state.challenges.delete(id)
            return record
          },
          receipt: async (id) => state.receipts.get(id) ?? null,
          registerReceipt: async (r) => {
            const key = `${r.farm_id}:${r.printer_key}`
            if (
              state.receipts.has(r.operation_id) ||
              state.assignments.has(key)
            )
              return { ok: false }
            const assignmentId = randomUUID()
            state.assignments.set(key, assignmentId)
            state.receipts.set(r.operation_id, {
              operation_id: r.operation_id,
              receipt_sha256: r.receipt_sha256,
              assignment_id: assignmentId,
            })
            return { ok: true, assignmentId }
          },
        })
      }
      const result = chain.then(run, run)
      chain = result.catch(() => {})
      return result
    },
  }
  return { state, store }
}

async function fixture() {
  const ed = () =>
    crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  const [issuer, connector] = await Promise.all([ed(), ed()])
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browser.publicKey,
  )
  const browserKey = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  ).toString('base64url')
  const fingerprint = await connectorFingerprintFromSpki(spki)
  const authority: ConfigurationAuthority = {
    account_id: 'account-owner',
    role: 'admin',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    browser_public_key: browserKey.publicKey,
    browser_thumbprint: browserKey.thumbprint,
    connector_public_key_spki: spki,
    connector_fingerprint: fingerprint,
    credential_jti: ids.jti,
    origin,
    audience,
    validUntil: Date.now() + 3_600_000,
  }
  const { state, store } = memoryStore()
  state.authority = authority
  const thumbprint = (await connectorKeyBinding(spki)).thumbprint
  const credentials = {
    async issue(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofRequest.parse(input)
      if (request.token !== token) return { ok: false, reason: 'denied' }
      const now = Date.now()
      return {
        ok: true,
        kind: 'challenge',
        challenge: {
          v: 1,
          agent_id: request.agentId,
          farm_id: request.farmId,
          jti: ids.jti,
          connection_id: request.connectionId,
          public_key_spki: spki,
          fingerprint,
          thumbprint,
          token_hash: createHash('sha256').update(token).digest('base64url'),
          origin,
          audience: credentialAudience,
          purpose: 'signalling',
          generation: 1,
          nonce: digest(),
          issued_at: now,
          expires_at: now + 30_000,
        },
      }
    },
    async accept(input: unknown): Promise<CredentialAcceptanceDecision> {
      const done = CredentialProofCompletion.parse(input)
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        connector.publicKey,
        Buffer.from(done.signature, 'base64url'),
        new Uint8Array(credentialProofPayload(done.challenge)),
      )
      if (!valid) return { ok: false, reason: 'denied' }
      return {
        ok: true,
        kind: 'accepted',
        agentId: done.agentId,
        farmId: done.farmId,
        jti: done.challenge.jti,
        connectionId: done.connectionId,
        purpose: 'signalling',
        acceptedAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      }
    },
  }
  const timers = { after: () => () => {} }
  const coordinator = new ConfigurationSignallingCoordinator({
    authority: {
      read: (scope) =>
        store.transaction(scope, async (tx) =>
          tx.authority
            ? { authority: tx.authority, observedAt: tx.observedAt }
            : null,
        ),
    },
    credentials,
    credentialAudience,
    clock: { wall: Date.now, monotonic: () => performance.now() },
    timers,
  })
  const a = authFixture()
  const runtime: ConfigurationHttpRuntime = {
    auth: a.auth,
    authority: createConfigurationAuthorityService({
      store,
      registry: coordinator,
      issuer: {
        issuer: 'open3dfarm:configuration-issuer',
        kid: 'config-test-1',
        privateKey: issuer.privateKey,
      },
    }),
    registration: createConfigurationRegistrationService({
      store,
      registry: coordinator,
    }),
  }
  function socket(role: 'browser' | 'connector', id?: string) {
    const sent: string[] = []
    let closed = false
    const session = createConfigurationSocketSession({
      role,
      sessionRecordId: id,
      coordinator,
      timers,
      port: {
        send: (wire) => void sent.push(wire),
        close: () => {
          closed = true
        },
      },
    })
    return {
      session,
      send: (frame: unknown) =>
        session.receive(encodeConfigurationSignallingClientFrame(frame)),
      last: () => decodeConfigurationSignallingServerFrame(sent.at(-1)),
      count: () => sent.length,
      get closed() {
        return closed
      },
    }
  }
  /** Drives both peers through the exported socket session, exactly as the routes do. */
  async function handshake() {
    const c = socket('connector')
    await c.send({
      v: 1,
      t: 'config.connector-begin',
      farm_id: ids.farm,
      agent_id: ids.agent,
      jti: ids.jti,
      token,
    })
    const challenge = c.last()
    if (challenge.t !== 'config.connector-challenge')
      throw new Error('challenge expected')
    await c.send({
      v: 1,
      t: 'config.connector-proof',
      signature: Buffer.from(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          connector.privateKey,
          new Uint8Array(credentialProofPayload(challenge.challenge)),
        ),
      ).toString('base64url'),
    })
    expect(c.last().t).toBe('config.connector-ready')
    await c.send({
      v: 1,
      t: 'config.advertise',
      protocol: 'config-v1',
      enabled: true,
      revision: 0,
    })
    const b = socket('browser', sessionRecordId)
    await b.send({
      v: 1,
      t: 'config.begin',
      farm_id: ids.farm,
      agent_id: ids.agent,
      key_id: ids.key,
    })
    const ready = b.last()
    if (ready.t !== 'config.ready') throw new Error('ready expected')
    const request = c.last()
    if (request.t !== 'config.context-request')
      throw new Error('context request expected')
    expect(request.transport_id).toBe(ready.transport_id)
    const rtc = (t: string, seed: string) => ({
      v: 1,
      transport_id: ready.transport_id,
      seq: 0,
      t,
      p: { sdp: sdp(seed) },
    })
    await c.send(rtc('rtc.offer', 'AA'))
    expect(b.last().t).toBe('rtc.offer')
    await b.send(rtc('rtc.answer', 'BB'))
    const bound = b.last()
    if (bound.t !== 'config.binding') throw new Error('binding expected')
    expect(c.last()).toEqual(bound)
    expect(bound.binding.connector_nonce).toBe(request.connector_nonce)
    const binding = bound.binding
    const proof = async (role: 'browser' | 'connector', key: CryptoKey) =>
      encodeConfigurationSessionProof({
        v: 1,
        role,
        binding,
        signature: await signConfigurationSessionProof(binding, role, key),
      })
    return {
      b,
      c,
      binding,
      browserProofWire: await proof('browser', browser.privateKey),
      connectorProofWire: await proof('connector', connector.privateKey),
    }
  }
  function event(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method?: string,
  ) {
    const base: Record<string, string> = { cookie, ...headers }
    return {
      req: new Request(
        origin + path,
        body === undefined
          ? { method: method ?? 'GET', headers: base }
          : {
              method: method ?? 'POST',
              headers: { origin, 'content-type': 'application/json', ...base },
              body: typeof body === 'string' ? body : JSON.stringify(body),
            },
      ),
      res: { headers: new Headers() },
    }
  }
  return {
    auth: a.auth,
    limits: a.limits,
    session: a.state,
    authority,
    state,
    issuer,
    browser,
    connector,
    fingerprint,
    coordinator,
    runtime,
    socket,
    handshake,
    event,
  }
}

test('config-v1 routes fail closed until a runtime with a real store is installed', async () => {
  expect(() => configurationHttpRuntime()).toThrowError(
    expect.objectContaining({ status: 404 }),
  )
  expect(configurationSignallingRuntime()).toBeUndefined()
  const dispatch = (path: string, method = 'POST') =>
    configurationMiddleware({
      req: new Request(origin + path, { method }),
      res: { headers: new Headers() },
    } as never)
  // Exact config-v1 paths answer 404 while disabled; anything else falls through.
  for (const path of [
    '/api/configuration-authority/challenges',
    '/api/configuration-authority/capabilities',
    `/api/farms/${ids.farm}/configuration-receipts`,
    `/api/farms/${ids.farm}/connectors/${ids.agent}/configuration?keyId=${ids.key}`,
  ])
    expect(() => dispatch(path)).toThrowError(
      expect.objectContaining({ status: 404 }),
    )
  for (const path of [
    '/api/configuration-authority/challenges/extra',
    '/api/configuration-authority/sign',
    `/api/farms/${ids.farm}/printers`,
    '/api/farms/not-a-uuid/configuration-receipts',
    '/api/pause-authority/challenges',
  ])
    expect(dispatch(path)).toBeUndefined()
  const closedHooks = configurationSocketHooks(
    'browser',
    configurationSignallingRuntime,
    () => true,
  )
  expect(((await closedHooks.upgrade({})) as Response).status).toBe(403)
  const gated = configurationSocketHooks(
    'connector',
    configurationSignallingRuntime,
    () => false,
  )
  expect(((await gated.upgrade({})) as Response).status).toBe(503)

  const f = await fixture()
  const signalling = new ConfigurationSignallingRuntime({
    origin,
    cookie: cookieConfig,
    coordinator: f.coordinator,
  })
  const uninstall = installConfigurationRuntime({
    http: f.runtime,
    signalling,
  })
  try {
    expect(configurationHttpRuntime()).toBe(f.runtime)
    // Installed: the middleware reaches the real handler and its session boundary.
    await expect(
      dispatch('/api/configuration-authority/challenges'),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      dispatch('/api/configuration-authority/capabilities', 'GET'),
    ).rejects.toMatchObject({ status: 405 })
    expect(configurationSignallingRuntime()).toBe(signalling)
    expect(() =>
      installConfigurationRuntime({ http: f.runtime, signalling }),
    ).toThrow()
    // An upgrade that is not the pinned native adapter never reaches a session.
    const hooks = configurationSocketHooks(
      'browser',
      configurationSignallingRuntime,
      () => true,
    )
    expect(((await hooks.upgrade({})) as Response).status).toBe(403)
  } finally {
    uninstall()
  }
  expect(signalling.isClosed).toBe(true)
  expect(configurationSignallingRuntime()).toBeUndefined()
  expect(
    await f.runtime.authority.issueChallenge({ sessionRecordId, request: {} }),
  ).toEqual({ ok: false, reason: 'denied' })
})

test('signalling frames are canonical, closed and carry no proxy fields', () => {
  const begin = {
    v: 1,
    t: 'config.begin',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
  }
  const wire = encodeConfigurationSignallingClientFrame(begin)
  expect(decodeConfigurationSignallingClientFrame(wire)).toEqual(begin)
  for (const invalid of [
    JSON.stringify(begin, null, 1),
    canonicalize({ ...begin, url: 'http://192.168.77.50/' }),
    canonicalize({ ...begin, assignment_id: randomUUID() }),
    canonicalize({ v: 1, t: 'config.prepare', target }),
    canonicalize({
      v: 1,
      t: 'config.advertise',
      protocol: 'config-v1',
      enabled: false,
      revision: 0,
    }),
    canonicalize({ ...begin, t: 'pause.begin' }),
    'x'.repeat(12289),
  ])
    expect(() => decodeConfigurationSignallingClientFrame(invalid)).toThrow()
})

test('socket sessions enforce order, authentication and a session-bound browser', async () => {
  const f = await fixture()
  // A browser socket has no say over its session: it comes from the sealed cookie.
  const anonymous = f.socket('browser')
  await anonymous.send({
    v: 1,
    t: 'config.begin',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
  })
  expect(anonymous.closed).toBe(true)
  // No advertising Connector yet: an authorized browser is still refused.
  const early = f.socket('browser', sessionRecordId)
  await early.send({
    v: 1,
    t: 'config.begin',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
  })
  expect(early.closed).toBe(true)
  expect(early.count()).toBe(0)
  // A Connector cannot advertise or relay before proving its credential.
  const unproved = f.socket('connector')
  await unproved.send({
    v: 1,
    t: 'config.advertise',
    protocol: 'config-v1',
    enabled: true,
    revision: 0,
  })
  expect(unproved.closed).toBe(true)
  expect(f.coordinator.advertised(ids.farm, ids.agent)).toBeNull()
  const wrongToken = f.socket('connector')
  await wrongToken.send({
    v: 1,
    t: 'config.connector-begin',
    farm_id: ids.farm,
    agent_id: ids.agent,
    jti: ids.jti,
    token: 'not-the-credential',
  })
  expect(wrongToken.closed).toBe(true)
  // Non-canonical or binary-ish input closes without a reply.
  const garbage = f.socket('connector')
  await garbage.session.receive('{ "v": 1 }')
  expect(garbage.closed).toBe(true)
  expect(garbage.count()).toBe(0)

  const live = await f.handshake()
  // Another browser session for the same account cannot join the transport.
  const foreign = f.socket('browser', 'another-session')
  await foreign.send({
    v: 1,
    t: 'config.begin',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
  })
  expect(foreign.closed).toBe(true)
  // Closing the browser socket ends the transport but keeps the Connector inbox.
  live.b.session.close()
  expect(live.c.last().t).toBe('config.context-closed')
  expect(live.c.closed).toBe(false)
  expect(f.coordinator.advertised(ids.farm, ids.agent)).toEqual({
    jti: ids.jti,
    revision: 0,
  })
  live.c.session.close()
  expect(f.coordinator.advertised(ids.farm, ids.agent)).toBeNull()
  expect(f.coordinator.snapshot()).toMatchObject({ inboxes: 0, contexts: 0 })
})

test('HTTP handlers issue a capability and register the committed receipt end to end', async () => {
  const f = await fixture()
  const bootstrapPath = `/api/farms/${ids.farm}/connectors/${ids.agent}/configuration?keyId=${ids.key}`
  const scope = { farmId: ids.farm, agentId: ids.agent }
  const offline = f.event(bootstrapPath)
  expect(
    await configurationBootstrapRequest(offline, f.runtime, scope),
  ).toMatchObject({ protocol: 'config-v1', available: false, revision: null })
  expect(offline.res.headers.get('cache-control')).toBe('no-store')

  const live = await f.handshake()
  expect(
    await configurationBootstrapRequest(
      f.event(bootstrapPath),
      f.runtime,
      scope,
    ),
  ).toEqual({
    protocol: 'config-v1',
    role: 'admin',
    available: true,
    revision: 0,
    connectorFingerprint: f.fingerprint,
    origin,
    audience,
    issuerKid: 'config-test-1',
  })

  const operationId = randomUUID()
  const targetSha256 = await configurationTargetHash(target)
  async function admit(action: 'prepare' | 'commit', hash: string) {
    const issued = await configurationAuthorityRequest(
      f.event('/api/configuration-authority/challenges', {
        browserProofWire: live.browserProofWire,
        connectorProofWire: live.connectorProofWire,
        admissionNonce: digest(),
        action,
        operationId,
        expectedRevision: 0,
        targetSha256: hash,
      }),
      f.runtime,
      'challenges',
    )
    if (!('challenge' in issued)) throw new Error('challenge expected')
    const admission = await signConfigurationAdmissionProof(
      issued.challenge,
      f.browser.privateKey,
    )
    const body = {
      admissionProofWire: encodeConfigurationAdmissionProof(admission),
    }
    const granted = await configurationAuthorityRequest(
      f.event('/api/configuration-authority/capabilities', body),
      f.runtime,
      'capabilities',
    )
    if (!('capability' in granted)) throw new Error('capability expected')
    // Replay of the same admission through HTTP is refused.
    await expect(
      configurationAuthorityRequest(
        f.event('/api/configuration-authority/capabilities', body),
        f.runtime,
        'capabilities',
      ),
    ).rejects.toMatchObject({ status: 403 })
    return { capability: granted.capability, admission }
  }
  const prepare = await admit('prepare', targetSha256)
  expect(
    await verifyConfigurationAuthorityEvidence({
      frame: {
        v: 1,
        protocol: 'config-v1',
        request_id: randomUUID(),
        operation_id: operationId,
        expected_revision: 0,
        type: 'prepare',
        target,
      },
      capability: prepare.capability,
      admission: prepare.admission,
      binding: live.binding,
      issuerKey: f.issuer.publicKey,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, evidence: 'cryptographic-only' })

  const claims = {
    v: 1,
    purpose: 'configuration-receipt',
    protocol: 'config-v1',
    account_id: 'account-owner',
    farm_id: ids.farm,
    agent_id: ids.agent,
    connector_fingerprint: f.fingerprint,
    operation_id: operationId,
    target: {
      target_sha256: targetSha256,
      device_id: target.device_id,
      bridge_instance_id: 'bridge-synthetic-1',
    },
    observed: {
      device_id: target.device_id,
      model: 'Kobra X',
      firmware: { status: 'unknown' },
      support: 'unqualified',
    },
    expected_revision: 0,
    recovery_reason: null,
    issued_at: Date.now(),
  }
  const prepared = await signConfigurationReceipt(
    {
      ...claims,
      receipt_id: randomUUID(),
      phase: 'prepared',
      committed_revision: null,
      prior_receipt_sha256: null,
    },
    f.connector.privateKey,
  )
  const preparedSha256 = await configurationReceiptHash(prepared)
  const receipts = `/api/farms/${ids.farm}/configuration-receipts`
  const post = (receipt: unknown, farmId = ids.farm) =>
    configurationReceiptRequest(
      f.event(receipts, {
        keyId: ids.key,
        receiptWire: encodeConfigurationReceipt(receipt),
      }),
      f.runtime,
      { farmId },
    )
  const committed = () =>
    signConfigurationReceipt(
      {
        ...claims,
        receipt_id: randomUUID(),
        phase: 'local-committed',
        committed_revision: 1,
        prior_receipt_sha256: preparedSha256,
      },
      f.connector.privateKey,
    )
  const local = await committed()
  // Before a commit admission exists, even a validly signed receipt is refused.
  await expect(post(local)).rejects.toMatchObject({ status: 403 })
  await expect(post(prepared)).rejects.toMatchObject({ status: 403 })
  await admit('commit', preparedSha256)
  const first = await post(local)
  expect(first).toMatchObject({ status: 'active', replayed: false })
  expect(await post(local)).toEqual({ ...first, replayed: true })
  await expect(post(await committed())).rejects.toMatchObject({ status: 409 })
  await expect(post(local, randomUUID())).rejects.toMatchObject({
    status: 403,
  })
  expect(f.state.assignments.size).toBe(1)
  expect(f.limits).toContain(`s:configuration:v1:receipts:${sessionRecordId}`)
})

test('HTTP boundary rejects foreign origin, missing session, bad transport and lost permission', async () => {
  const f = await fixture()
  const live = await f.handshake()
  const path = '/api/configuration-authority/challenges'
  const body = {
    browserProofWire: live.browserProofWire,
    connectorProofWire: live.connectorProofWire,
    admissionNonce: digest(),
    action: 'prepare',
    operationId: randomUUID(),
    expectedRevision: 0,
    targetSha256: digest(),
  }
  const challenge = (event: ReturnType<typeof f.event>) =>
    configurationAuthorityRequest(event, f.runtime, 'challenges')
  const cases: [ReturnType<typeof f.event>, number][] = [
    [f.event(path, body, { origin: 'https://evil.invalid' }), 403],
    [f.event(path, body, { cookie: '' }), 401],
    [f.event(path), 405],
    [f.event(path + '?farm=1', body), 400],
    [f.event(path, body, { 'content-type': 'text/plain' }), 415],
    [f.event(path, body, { 'content-encoding': 'gzip' }), 415],
    [f.event(path, 'x'.repeat(51201)), 413],
    [f.event(path, '{'), 400],
    [f.event(path, { ...body, url: 'http://192.168.77.50/' }), 400],
    [f.event(path, { ...body, action: 'proxy' }), 400],
    [f.event(path, { ...body, password: 'secret' }), 400],
    [f.event(path, { ...body, browserProofWire: '{}' }), 400],
  ]
  for (const [event, status] of cases)
    await expect(challenge(event), String(status)).rejects.toMatchObject({
      status,
    })
  expect(f.state.operations.size).toBe(0)

  f.session.decision = { ok: false, reason: 'revoked' }
  await expect(challenge(f.event(path, body))).rejects.toMatchObject({
    status: 401,
  })
  f.session.decision = {
    ok: true,
    accountId: 'account-owner',
    touchAt: Date.now(),
  }
  f.session.quota = false
  await expect(challenge(f.event(path, body))).rejects.toMatchObject({
    status: 429,
  })
  f.session.quota = true
  for (const role of ['operator', 'viewer']) {
    f.state.authority = { ...f.authority, role }
    await expect(challenge(f.event(path, body))).rejects.toMatchObject({
      status: 403,
    })
  }
  f.state.authority = f.authority
  const granted = await challenge(f.event(path, body))
  expect('challenge' in granted && granted.challenge.action).toBe('prepare')

  const scope = { farmId: ids.farm, agentId: ids.agent }
  const base = `/api/farms/${ids.farm}/connectors/${ids.agent}/configuration`
  for (const query of ['', '?keyId=x', `?keyId=${ids.key}&farm=1`])
    await expect(
      configurationBootstrapRequest(f.event(base + query), f.runtime, scope),
    ).rejects.toMatchObject({ status: 400 })
  await expect(
    configurationBootstrapRequest(
      f.event(`${base}?keyId=${randomUUID()}`),
      f.runtime,
      scope,
    ),
  ).rejects.toMatchObject({ status: 403 })
  await expect(
    readConfigurationBody(
      new Request(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1,"a":2}',
      }),
      1024,
    ),
  ).rejects.toMatchObject({ status: 400 })
})
