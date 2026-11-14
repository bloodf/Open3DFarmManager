import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  CredentialProofCompletion,
  CredentialProofRequest,
  credentialProofPayload,
  type CredentialProofChallenge,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import {
  configurationBindingHash,
  connectorFingerprintFromSpki,
  encodeConfigurationSessionProof,
  signConfigurationSessionProof,
  type ConfigurationSessionBinding,
} from '../../packages/farm-protocol/src/configuration-binding.ts'
import {
  encodeConfigurationAdmissionProof,
  signConfigurationAdmissionProof,
  verifyConfigurationAuthorityEvidence,
  type SignedConfigurationCapabilityV1,
} from '../../packages/farm-protocol/src/configuration-capability.ts'
import {
  decodeConfigurationInventoryAck,
  deriveConfigurationAssignmentIdentity,
  verifyConfigurationInventoryAck,
} from '../../packages/farm-protocol/src/configuration-inventory.ts'
import {
  configurationReceiptHash,
  encodeConfigurationReceipt,
  signConfigurationReceipt,
} from '../../packages/farm-protocol/src/configuration-receipt.ts'
import { configurationTargetHash } from '../../packages/farm-protocol/src/configuration-target.ts'
import { connectorKeyBinding } from '../../apps/farm/server/utils/connector-credentials.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import type {
  ConfigurationAuthority,
  ConfigurationAuthorityStore,
  ConfigurationAuthorityTransaction,
  ConfigurationChallengeRecord,
  ConfigurationOperationRecord,
  ConfigurationReceiptRecord,
  ConfigurationReceiptRegistration,
} from '../../apps/farm/server/services/configuration-authority-contract.ts'
import { createConfigurationAuthorityService } from '../../apps/farm/server/services/configuration-authority.ts'
import { createConfigurationRegistrationService } from '../../apps/farm/server/services/configuration-receipt-registration.ts'
import {
  ConfigurationSignallingCoordinator,
  type ConfigurationSignallingEndpoint,
  type ConfigurationSignallingHandle,
} from '../../apps/farm/server/services/configuration-signalling-coordinator.ts'
import { decodeConfigurationSignallingServerFrame } from '../../apps/farm/server/services/configuration-signalling-wire.ts'

const NOW = 1_800_000_000_000
const origin = 'https://farm.example.invalid'
const audience = 'open3dfarm:configuration'
const credentialAudience = 'open3dfarm:connector'
const ids = {
  farm: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
  key: '44444444-4444-4444-8444-444444444444',
  jti: '55555555-5555-4555-8555-555555555555',
}
const sessionRecordId = 'configuration-session'
const token = 'synthetic-connector-credential'
const sdp = (seed: string) =>
  `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(seed).join(':')}\r\na=setup:actpass\r\n`
const digest = () => randomBytes(32).toString('base64url')
const target = {
  v: 1,
  protocol: 'config-v1',
  backend: 'kobralink-anycubic',
  model: { family: 'anycubic-kobra-x', provisional: true },
  endpoint: { ipv4: '192.168.77.50', port: 18910 },
  device_id: 'kobra-x-synthetic-1',
  bridge: { kind: 'connector-managed' },
}
const spkiOf = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('spki', key)).toString('base64url')

/** Synthetic serializable store: one transaction at a time, rollback on rejection. */
function memoryStore(clock: { wall(): number }) {
  const state = {
    sessionRecordId,
    authority: null as unknown,
    operations: new Map<string, ConfigurationOperationRecord>(),
    challenges: new Map<string, ConfigurationChallengeRecord>(),
    nonces: new Set<string>(),
    receipts: new Map<
      string,
      ConfigurationReceiptRecord & { wire: string; printerKey: string }
    >(),
    assignments: new Map<string, string>(),
    failNext: false,
  }
  let chain: Promise<unknown> = Promise.resolve()
  const store: ConfigurationAuthorityStore = {
    transaction(scope, work) {
      const run = async () => {
        if (state.failNext) {
          state.failNext = false
          throw new Error('synthetic storage failure')
        }
        const backup = {
          operations: new Map(state.operations),
          challenges: new Map(state.challenges),
          nonces: new Set(state.nonces),
          receipts: new Map(state.receipts),
          assignments: new Map(state.assignments),
        }
        const a = state.authority as ConfigurationAuthority | null
        const tx: ConfigurationAuthorityTransaction = {
          authority:
            a &&
            scope.sessionRecordId === state.sessionRecordId &&
            scope.farmId === a.farm_id &&
            scope.agentId === a.agent_id &&
            scope.keyId === a.key_id
              ? structuredClone(a)
              : null,
          observedAt: clock.wall(),
          operation: async (id) => state.operations.get(id) ?? null,
          createOperation: async (record) => {
            if (state.operations.has(record.operation_id)) return false
            state.operations.set(record.operation_id, record)
            return true
          },
          pinCommit: async (id, commit) => {
            const op = state.operations.get(id)
            if (!op || op.commit_sha256 !== null) return false
            state.operations.set(id, { ...op, commit_sha256: commit })
            return true
          },
          insertChallenge: async (record) => {
            const c = record.challenge
            if (
              state.challenges.has(c.challenge_id) ||
              state.nonces.has(c.admission_nonce)
            )
              return false
            state.nonces.add(c.admission_nonce)
            state.challenges.set(c.challenge_id, record)
            return true
          },
          consumeChallenge: async (id) => {
            const record = state.challenges.get(id) ?? null
            state.challenges.delete(id)
            return record
          },
          receipt: async (id) => {
            const r = state.receipts.get(id)
            return r
              ? {
                  operation_id: r.operation_id,
                  receipt_sha256: r.receipt_sha256,
                  assignment_id: r.assignment_id,
                }
              : null
          },
          registerReceipt: async (r: ConfigurationReceiptRegistration) => {
            const key = `${r.farm_id}:${r.printer_key}`
            if (
              state.receipts.has(r.operation_id) ||
              state.assignments.has(key)
            )
              return { ok: false }
            state.assignments.set(key, r.assignment_id)
            state.receipts.set(r.operation_id, {
              operation_id: r.operation_id,
              receipt_sha256: r.receipt_sha256,
              assignment_id: r.assignment_id,
              wire: r.receipt_wire,
              printerKey: r.printer_key,
            })
            return { ok: true, assignmentId: r.assignment_id }
          },
        }
        try {
          return await work(tx)
        } catch (error) {
          Object.assign(state, backup)
          throw error
        }
      }
      const result = chain.then(run, run)
      chain = result.catch(() => {})
      return result
    },
  }
  return { state, store }
}

function endpoint() {
  const sent: string[] = []
  let closed = false
  const port: ConfigurationSignallingEndpoint = {
    purpose: 'configuration',
    armDeadline: () => () => {},
    send: (wire) => {
      sent.push(wire)
    },
    close: () => {
      closed = true
    },
  }
  return {
    port,
    sent,
    frames: () => sent.map((w) => decodeConfigurationSignallingServerFrame(w)),
    get closed() {
      return closed
    },
  }
}

async function fixture() {
  let wall = NOW
  let monotonic = 1000
  const clock = { wall: () => wall, monotonic: () => monotonic }
  const advance = (ms: number) => {
    wall += ms
    monotonic += ms
  }
  const generate = () =>
    crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  const [issuer, connector, otherConnector] = await Promise.all([
    generate(),
    generate(),
    generate(),
  ])
  const p256 = () =>
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])
  const [browser, otherBrowser] = await Promise.all([p256(), p256()])
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browser.publicKey,
  )
  const browserKey = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const spki = await spkiOf(connector.publicKey)
  const fingerprint = await connectorFingerprintFromSpki(spki)
  const authority: ConfigurationAuthority = {
    account_id: 'account-owner',
    role: 'owner',
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
    validUntil: NOW + 3_600_000,
  }
  const { state, store } = memoryStore(clock)
  state.authority = authority
  const thumbprint = (await connectorKeyBinding(spki)).thumbprint
  const credentials = {
    async issue(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofRequest.parse(input)
      if (request.token !== token) return { ok: false, reason: 'denied' }
      const currentJti =
        (state.authority as ConfigurationAuthority | null)?.credential_jti ??
        ids.jti
      const challenge: CredentialProofChallenge = {
        v: 1,
        agent_id: request.agentId,
        farm_id: request.farmId,
        jti: currentJti,
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
        issued_at: wall,
        expires_at: wall + 30_000,
      }
      return { ok: true, kind: 'challenge', challenge }
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
        acceptedAt: wall,
        expiresAt: wall + 600_000,
      }
    },
  }
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
    clock,
    timers: { after: () => () => {} },
  })
  const issuerConfig = {
    issuer: 'open3dfarm:configuration-issuer',
    kid: 'config-test-1',
    privateKey: issuer.privateKey,
  }
  const authorityService = createConfigurationAuthorityService({
    store,
    registry: coordinator,
    issuer: issuerConfig,
  })
  const registration = createConfigurationRegistrationService({
    store,
    registry: coordinator,
    issuer: issuerConfig,
  })
  const scope = {
    sessionRecordId,
    farmId: ids.farm,
    agentId: ids.agent,
    keyId: ids.key,
  }

  async function connectInbox(
    options: { advertise?: boolean; jti?: string } = {},
  ) {
    const ep = endpoint()
    const currentJti =
      options.jti ??
      (state.authority as ConfigurationAuthority | null)?.credential_jti ??
      ids.jti
    const begun = await coordinator.connectorBegin(
      { farmId: ids.farm, agentId: ids.agent, jti: currentJti, token },
      ep.port,
    )
    assert.equal(begun?.kind, 'challenge')
    if (begun?.kind !== 'challenge') throw new Error('unreachable')
    const signature = Buffer.from(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        connector.privateKey,
        new Uint8Array(credentialProofPayload(begun.challenge)),
      ),
    ).toString('base64url')
    const ready = await coordinator.connectorProve(begun.handle, signature)
    assert.ok(ready)
    if (options.advertise !== false)
      assert.equal(coordinator.advertise(begun.handle, { revision: 0 }), true)
    return { ep, handle: begun.handle }
  }
  const rtc = (
    transportId: string,
    seq: number,
    t: 'rtc.offer' | 'rtc.answer',
    seed: string,
  ) =>
    canonicalize({
      v: 1,
      transport_id: transportId,
      seq,
      t,
      p: { sdp: sdp(seed) },
    })

  /** Full authenticated handshake: returns the server-issued binding and both proof wires. */
  async function negotiate(inbox?: {
    ep: ReturnType<typeof endpoint>
    handle: ConfigurationSignallingHandle
  }) {
    const connectorSide = inbox ?? (await connectInbox())
    const browserSide = endpoint()
    const opened = await coordinator.open(scope, browserSide.port)
    assert.ok(opened, 'owner browser admitted without any assignment')
    const ready = decodeConfigurationSignallingServerFrame(opened.readyWire)
    assert.equal(ready.t, 'config.ready')
    if (ready.t !== 'config.ready') throw new Error('unreachable')
    const request = connectorSide.ep.frames().at(-1)
    assert.equal(request?.t, 'config.context-request')
    const id = ready.transport_id
    assert.equal(
      await coordinator.relay(
        connectorSide.handle,
        rtc(id, 0, 'rtc.offer', 'AA'),
      ),
      true,
    )
    assert.equal(
      await coordinator.relay(opened.handle, rtc(id, 0, 'rtc.answer', 'BB')),
      true,
    )
    const bound = browserSide.frames().at(-1)
    assert.equal(bound?.t, 'config.binding')
    if (bound?.t !== 'config.binding') throw new Error('unreachable')
    assert.deepEqual(connectorSide.ep.frames().at(-1), bound)
    const binding = bound.binding
    assert.equal(binding.browser_nonce, ready.browser_nonce)
    const proofs = await proofsFor(binding)
    return { binding, ...proofs, browserSide, connectorSide, opened }
  }
  async function proofsFor(binding: ConfigurationSessionBinding) {
    const wire = async (role: 'browser' | 'connector', key: CryptoKey) =>
      encodeConfigurationSessionProof({
        v: 1,
        role,
        binding,
        signature: await signConfigurationSessionProof(binding, role, key),
      })
    return {
      browserProofWire: await wire('browser', browser.privateKey),
      connectorProofWire: await wire('connector', connector.privateKey),
    }
  }
  async function challenge(
    session: { browserProofWire: string; connectorProofWire: string },
    request: {
      action: 'prepare' | 'commit' | 'status' | 'cancel'
      operationId: string
      expectedRevision?: number
      targetSha256: string
    },
    id = sessionRecordId,
  ) {
    return authorityService.issueChallenge({
      sessionRecordId: id,
      request: {
        browserProofWire: session.browserProofWire,
        connectorProofWire: session.connectorProofWire,
        admissionNonce: digest(),
        expectedRevision: 0,
        ...request,
      },
    })
  }
  async function capability(
    issued: Awaited<ReturnType<typeof challenge>>,
    key: CryptoKey = browser.privateKey,
  ) {
    assert.equal(issued.ok, true)
    if (!issued.ok) throw new Error('unreachable')
    const admission = await signConfigurationAdmissionProof(
      issued.challenge,
      key,
    )
    const result = await authorityService.issueCapability({
      sessionRecordId,
      request: {
        admissionProofWire: encodeConfigurationAdmissionProof(admission),
      },
    })
    return { result, admission }
  }
  async function receipt(
    operationId: string,
    phase: 'prepared' | 'local-committed' | 'recovery-required',
    overrides: Record<string, unknown> = {},
    key: CryptoKey = connector.privateKey,
  ) {
    return signConfigurationReceipt(
      {
        v: 1,
        purpose: 'configuration-receipt',
        protocol: 'config-v1',
        receipt_id: randomUUID(),
        account_id: authority.account_id,
        farm_id: ids.farm,
        agent_id: ids.agent,
        connector_fingerprint: fingerprint,
        operation_id: operationId,
        phase,
        target: {
          target_sha256: await configurationTargetHash(target),
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
        committed_revision: phase === 'local-committed' ? 1 : null,
        recovery_reason: null,
        prior_receipt_sha256: null,
        issued_at: wall,
        ...overrides,
      },
      key,
    )
  }
  /** prepare + commit admissions, then the Connector's committed receipt. */
  async function committed(session: Awaited<ReturnType<typeof negotiate>>) {
    const operationId = randomUUID()
    const targetSha256 = await configurationTargetHash(target)
    const prepare = await capability(
      await challenge(session, {
        action: 'prepare',
        operationId,
        targetSha256,
      }),
    )
    assert.equal(prepare.result.ok, true)
    const prepared = await receipt(operationId, 'prepared')
    const preparedSha256 = await configurationReceiptHash(prepared)
    const commit = await capability(
      await challenge(session, {
        action: 'commit',
        operationId,
        targetSha256: preparedSha256,
      }),
    )
    assert.equal(commit.result.ok, true)
    const local = await receipt(operationId, 'local-committed', {
      prior_receipt_sha256: preparedSha256,
    })
    return {
      operationId,
      targetSha256,
      prepared,
      preparedSha256,
      local,
      prepare,
      commit,
    }
  }
  const register = (signed: unknown, id = sessionRecordId, keyId = ids.key) =>
    registration.register({
      sessionRecordId: id,
      farmId: ids.farm,
      request: { keyId, receiptWire: encodeConfigurationReceipt(signed) },
    })
  return {
    advance,
    authority,
    state,
    issuer,
    browser,
    otherBrowser,
    connector,
    otherConnector,
    coordinator,
    authorityService,
    registration,
    scope,
    connectInbox,
    negotiate,
    proofsFor,
    challenge,
    capability,
    receipt,
    committed,
    register,
    now: () => wall,
  }
}

test('zero-printer Connector bootstrap and signalling need an authenticated, advertising Connector', async () => {
  const f = await fixture()
  assert.equal(f.state.assignments.size, 0)
  const before = await f.registration.bootstrap(f.scope)
  assert.equal(before.ok && before.available, false)
  assert.equal(await f.coordinator.open(f.scope, endpoint().port), null)
  // Authenticated but not locally enabled: metadata stays unavailable and no context opens.
  const silent = await f.connectInbox({ advertise: false })
  assert.equal(f.coordinator.advertised(ids.farm, ids.agent), null)
  assert.equal(await f.coordinator.open(f.scope, endpoint().port), null)
  assert.equal(f.coordinator.advertise(silent.handle, { revision: 3 }), true)
  const after = await f.registration.bootstrap(f.scope)
  assert.deepEqual(after, {
    ok: true,
    protocol: 'config-v1',
    role: 'owner',
    available: true,
    revision: 3,
    connectorFingerprint: f.authority.connector_fingerprint,
    origin,
    audience,
  })
  // Wrong credential token or a forged proof never produces an inbox.
  assert.equal(
    await f.coordinator.connectorBegin(
      { farmId: ids.farm, agentId: ids.agent, jti: ids.jti, token: 'other' },
      endpoint().port,
    ),
    null,
  )
  const forged = endpoint()
  const begun = await f.coordinator.connectorBegin(
    { farmId: ids.farm, agentId: ids.agent, jti: ids.jti, token },
    forged.port,
  )
  assert.equal(begun?.kind, 'challenge')
  if (begun?.kind !== 'challenge') return
  const bad = Buffer.from(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      f.otherConnector.privateKey,
      new Uint8Array(credentialProofPayload(begun.challenge)),
    ),
  ).toString('base64url')
  assert.equal(await f.coordinator.connectorProve(begun.handle, bad), null)
  assert.equal(forged.closed, true)
  assert.equal(f.coordinator.advertise(begun.handle, { revision: 0 }), false)
  // Bootstrap is owner/admin only and bound to the caller's own session and device.
  for (const scope of [
    { ...f.scope, sessionRecordId: 'another-session' },
    { ...f.scope, keyId: randomUUID() },
    { ...f.scope, farmId: randomUUID() },
  ])
    assert.deepEqual(await f.registration.bootstrap(scope), {
      ok: false,
      reason: 'denied',
    })
  for (const role of ['operator', 'viewer']) {
    f.state.authority = { ...f.authority, role }
    assert.deepEqual(await f.registration.bootstrap(f.scope), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(await f.coordinator.open(f.scope, endpoint().port), null)
  }
})

test('challenge and admission yield a capability the Connector-side verifier accepts for this exact handshake', async () => {
  const f = await fixture()
  const session = await f.negotiate()
  const operationId = randomUUID()
  const targetSha256 = await configurationTargetHash(target)
  const issued = await f.challenge(session, {
    action: 'prepare',
    operationId,
    targetSha256,
  })
  assert.equal(issued.ok, true)
  if (!issued.ok) return
  assert.equal(
    issued.challenge.configuration_binding_sha256,
    await configurationBindingHash(session.binding),
  )
  assert.ok(issued.challenge.expires_at - issued.challenge.issued_at <= 8000)
  const { result, admission } = await f.capability(issued)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const claims: SignedConfigurationCapabilityV1 = result.capability
  assert.equal(claims.role, 'owner')
  assert.equal(claims.action, 'prepare')
  assert.equal(claims.operation_id, operationId)
  assert.equal(claims.target_sha256, targetSha256)
  assert.ok(claims.expires_at - claims.issued_at <= 30_000)
  const frame = {
    v: 1,
    protocol: 'config-v1',
    request_id: randomUUID(),
    operation_id: operationId,
    expected_revision: 0,
    type: 'prepare',
    target,
  }
  const evidence = await verifyConfigurationAuthorityEvidence({
    frame,
    capability: claims,
    admission,
    binding: session.binding,
    issuerKey: f.issuer.publicKey,
    now: f.now(),
  })
  assert.equal(evidence.ok, true)
  // The same capability does not cover another target, action or handshake.
  const moved = await verifyConfigurationAuthorityEvidence({
    frame: { ...frame, target: { ...target, device_id: 'another-device' } },
    capability: claims,
    admission,
    binding: session.binding,
    issuerKey: f.issuer.publicKey,
    now: f.now(),
  })
  assert.deepEqual(moved, { ok: false, reason: 'target-mismatch' })
  // Replayed admission: the challenge was consumed exactly once.
  const replay = await f.authorityService.issueCapability({
    sessionRecordId,
    request: {
      admissionProofWire: encodeConfigurationAdmissionProof(admission),
    },
  })
  assert.deepEqual(replay, { ok: false, reason: 'denied' })
})

test('authority is revalidated on every prepare/commit admission', async () => {
  const f = await fixture()
  const session = await f.negotiate()
  const targetSha256 = await configurationTargetHash(target)
  const prepare = (operationId: string = randomUUID()) =>
    f.challenge(session, { action: 'prepare', operationId, targetSha256 })
  const deniedResult = { ok: false, reason: 'denied' }

  // Another session, and a binding the server never issued.
  assert.deepEqual(
    await f.challenge(
      session,
      { action: 'prepare', operationId: randomUUID(), targetSha256 },
      'another-session',
    ),
    deniedResult,
  )
  const invented = await f.proofsFor({
    ...session.binding,
    browser_nonce: digest(),
  })
  assert.deepEqual(
    await f.challenge(invented, {
      action: 'prepare',
      operationId: randomUUID(),
      targetSha256,
    }),
    deniedResult,
  )
  // Connector proof signed by a key that is not the enrolled identity.
  const forged = encodeConfigurationSessionProof({
    v: 1,
    role: 'connector',
    binding: session.binding,
    signature: Buffer.from(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        f.otherConnector.privateKey,
        new Uint8Array(32),
      ),
    ).toString('base64url'),
  })
  assert.deepEqual(
    await f.challenge(
      { ...session, connectorProofWire: forged },
      { action: 'prepare', operationId: randomUUID(), targetSha256 },
    ),
    deniedResult,
  )

  // Wrong admission signature consumes the challenge and yields nothing.
  const wrongKey = await f.capability(
    await prepare(),
    f.otherBrowser.privateKey,
  )
  assert.deepEqual(wrongKey.result, deniedResult)

  // Revocation or role downgrade between challenge and capability.
  for (const changed of [null, { ...f.authority, role: 'operator' }]) {
    const issued = await prepare()
    f.state.authority = changed
    assert.deepEqual((await f.capability(issued)).result, deniedResult)
    f.state.authority = f.authority
  }
  // Different device or rotated Connector credential under the same account.
  for (const changed of [
    { ...f.authority, credential_jti: randomUUID() },
    { ...f.authority, account_id: 'account-other' },
  ]) {
    const issued = await prepare()
    f.state.authority = changed
    assert.deepEqual((await f.capability(issued)).result, deniedResult)
    assert.deepEqual(await prepare(), deniedResult)
    f.state.authority = f.authority
  }

  // Operation pinning: revision, target and commit hash cannot change.
  const operationId = randomUUID()
  assert.equal((await prepare(operationId)).ok, true)
  assert.deepEqual(
    await f.challenge(session, {
      action: 'prepare',
      operationId,
      targetSha256: digest(),
    }),
    deniedResult,
  )
  assert.deepEqual(
    await f.challenge(session, {
      action: 'status',
      operationId,
      targetSha256,
      expectedRevision: 1,
    }),
    deniedResult,
  )
  assert.deepEqual(
    await f.challenge(session, {
      action: 'commit',
      operationId: randomUUID(),
      targetSha256,
    }),
    deniedResult,
    'commit needs a prepared operation',
  )
  const pinned = digest()
  assert.equal(
    (
      await f.challenge(session, {
        action: 'commit',
        operationId,
        targetSha256: pinned,
      })
    ).ok,
    true,
  )
  assert.deepEqual(
    await f.challenge(session, {
      action: 'commit',
      operationId,
      targetSha256: digest(),
    }),
    deniedResult,
  )

  // Storage failure is reported as such and leaves nothing half-written.
  f.state.failNext = true
  assert.deepEqual(await prepare(), {
    ok: false,
    reason: 'storage-unavailable',
  })

  // Expired admission challenge.
  const late = await prepare()
  f.advance(8001)
  assert.deepEqual((await f.capability(late)).result, deniedResult)

  // Stale Connector: its inbox closed, so the binding is no longer live.
  const fresh = await prepare()
  assert.equal(fresh.ok, true)
  f.coordinator.closeHandle(session.connectorSide.handle)
  assert.equal(session.browserSide.closed, true)
  assert.deepEqual((await f.capability(fresh)).result, deniedResult)
  assert.deepEqual(await prepare(), deniedResult)
})

test('binding expiry and relay rules close the configuration transport', async () => {
  const f = await fixture()
  const session = await f.negotiate()
  const hash = await configurationBindingHash(session.binding)
  assert.ok(f.coordinator.bound(hash))
  assert.ok(session.binding.expires_at - session.binding.issued_at <= 30_000)
  // One configuration context per Connector and per browser device.
  assert.equal(await f.coordinator.open(f.scope, endpoint().port), null)
  f.advance(30_001)
  assert.equal(f.coordinator.bound(hash), null)
  assert.equal(session.browserSide.closed, true)
  assert.deepEqual(
    await f.challenge(session, {
      action: 'prepare',
      operationId: randomUUID(),
      targetSha256: digest(),
    }),
    { ok: false, reason: 'denied' },
  )

  // A browser may not offer, and frames of another transport are refused.
  const g = await fixture()
  const inbox = await g.connectInbox()
  const browserSide = endpoint()
  const opened = await g.coordinator.open(g.scope, browserSide.port)
  assert.ok(opened)
  const ready = decodeConfigurationSignallingServerFrame(opened.readyWire)
  if (ready.t !== 'config.ready') throw new Error('unreachable')
  const offer = (transportId: string) =>
    canonicalize({
      v: 1,
      transport_id: transportId,
      seq: 0,
      t: 'rtc.offer',
      p: { sdp: sdp('AA') },
    })
  assert.equal(
    await g.coordinator.relay(inbox.handle, offer(randomUUID())),
    false,
  )
  assert.equal(browserSide.closed, true)
  assert.equal(inbox.ep.frames().at(-1)?.t, 'config.context-closed')
  const again = endpoint()
  const reopened = await g.coordinator.open(g.scope, again.port)
  assert.ok(reopened, 'the Connector inbox survives a refused transport')
  const next = decodeConfigurationSignallingServerFrame(reopened.readyWire)
  if (next.t !== 'config.ready') throw new Error('unreachable')
  assert.equal(
    await g.coordinator.relay(reopened.handle, offer(next.transport_id)),
    false,
  )
  assert.equal(again.closed, true)
  // Revocation while negotiating closes before any binding exists.
  const third = endpoint()
  const last = await g.coordinator.open(g.scope, third.port)
  assert.ok(last)
  const lastReady = decodeConfigurationSignallingServerFrame(last.readyWire)
  if (lastReady.t !== 'config.ready') throw new Error('unreachable')
  g.state.authority = null
  assert.equal(
    await g.coordinator.relay(inbox.handle, offer(lastReady.transport_id)),
    false,
  )
  assert.equal(third.closed, true)
  assert.equal(third.sent.length, 0)
  g.coordinator.dispose()
  assert.equal(inbox.ep.closed, true)
  assert.deepEqual(g.coordinator.snapshot(), {
    inboxes: 0,
    contexts: 0,
    authorityTasks: 0,
    cryptoTasks: 0,
    disposed: true,
  })
})

test('a committed Connector receipt registers the assignment idempotently', async () => {
  const f = await fixture()
  const session = await f.negotiate()
  const op = await f.committed(session)
  const identity = await deriveConfigurationAssignmentIdentity({
    account_id: f.authority.account_id,
    farm_id: ids.farm,
    agent_id: ids.agent,
    bridge_instance_id: 'bridge-synthetic-1',
    device_id: target.device_id,
  })
  const first = await f.register(op.local)
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.replayed, false)
  assert.equal(first.status, 'active')
  assert.equal(first.assignmentId, identity.assignment_id)
  assert.equal(first.printerKey, identity.printer_key)
  assert.equal(first.receiptSha256, await configurationReceiptHash(op.local))
  const firstAck = decodeConfigurationInventoryAck(first.inventoryAckWire)
  assert.equal(
    await verifyConfigurationInventoryAck(
      firstAck,
      f.issuer.publicKey,
      {
        context: {
          account_id: f.authority.account_id,
          farm_id: ids.farm,
          agent_id: ids.agent,
          key_id: ids.key,
          transport_id: session.binding.transport_id,
          browser_thumbprint: f.authority.browser_thumbprint,
          connector_fingerprint: f.authority.connector_fingerprint,
          credential_jti: f.authority.credential_jti,
          configuration_binding_sha256: await configurationBindingHash(
            session.binding,
          ),
          origin,
          audience,
        },
        kid: 'config-test-1',
        issuer: 'open3dfarm:configuration-issuer',
        operation_id: op.operationId,
        committed_receipt_sha256: first.receiptSha256,
        committed_revision: 1,
        assignment_id: identity.assignment_id,
        printer_key: identity.printer_key,
      },
      f.now(),
    ),
    true,
  )
  // Lost acknowledgement: the same receipt returns the same assignment and a fresh signed ack.
  const retry = await f.register(op.local)
  assert.equal(retry.ok, true)
  if (!retry.ok) return
  assert.deepEqual(retry, {
    ...first,
    replayed: true,
    inventoryAckWire: retry.inventoryAckWire,
  })
  assert.notEqual(
    decodeConfigurationInventoryAck(retry.inventoryAckWire).nonce,
    firstAck.nonce,
  )
  assert.equal(f.state.assignments.size, 1)
  // Only nonsecret evidence is stored: no address, cookie or password.
  const stored = f.state.receipts.get(op.operationId)
  assert.equal(stored?.printerKey, identity.printer_key)
  assert.equal(stored?.wire.includes(target.endpoint.ipv4), false)
  assert.doesNotMatch(stored?.wire ?? '', /password|cookie|token|secret/i)
  // A different committed receipt for the same operation conflicts.
  const other = await f.receipt(op.operationId, 'local-committed', {
    prior_receipt_sha256: op.preparedSha256,
  })
  assert.deepEqual(await f.register(other), { ok: false, reason: 'conflict' })
  // A registered operation cannot be prepared or committed again, only inspected.
  assert.deepEqual(
    await f.challenge(session, {
      action: 'commit',
      operationId: op.operationId,
      targetSha256: op.preparedSha256,
    }),
    { ok: false, reason: 'denied' },
  )
  assert.equal(
    (
      await f.challenge(session, {
        action: 'status',
        operationId: op.operationId,
        targetSha256: op.targetSha256,
      })
    ).ok,
    true,
  )
  // Another operation for the same device cannot take the active printer key.
  const second = await f.committed(session)
  assert.deepEqual(await f.register(second.local), {
    ok: false,
    reason: 'conflict',
  })
  // After the 30s binding expires and the Connector credential rotates, an offline
  // or revoked caller is denied, while a fresh authenticated session re-issues the
  // signed inventory ack for the new transport without creating a second printer.
  f.advance(30_001)
  const rotatedJti = randomUUID()
  f.state.authority = { ...f.authority, credential_jti: rotatedJti }
  assert.deepEqual(await f.register(op.local), { ok: false, reason: 'denied' })
  const freshSession = await f.negotiate()
  f.state.authority = {
    ...f.authority,
    credential_jti: rotatedJti,
    role: 'viewer',
  }
  assert.deepEqual(await f.register(op.local), { ok: false, reason: 'denied' })
  f.state.authority = { ...f.authority, credential_jti: rotatedJti }
  const freshRetry = await f.register(op.local)
  assert.equal(freshRetry.ok, true)
  if (!freshRetry.ok) return
  assert.equal(freshRetry.replayed, true)
  assert.equal(freshRetry.assignmentId, identity.assignment_id)
  assert.equal(freshRetry.printerKey, identity.printer_key)
  assert.equal(f.state.assignments.size, 1)
  const freshAck = decodeConfigurationInventoryAck(freshRetry.inventoryAckWire)
  assert.equal(
    await verifyConfigurationInventoryAck(
      freshAck,
      f.issuer.publicKey,
      {
        context: {
          account_id: f.authority.account_id,
          farm_id: ids.farm,
          agent_id: ids.agent,
          key_id: ids.key,
          transport_id: freshSession.binding.transport_id,
          browser_thumbprint: f.authority.browser_thumbprint,
          connector_fingerprint: f.authority.connector_fingerprint,
          credential_jti: rotatedJti,
          configuration_binding_sha256: await configurationBindingHash(
            freshSession.binding,
          ),
          origin,
          audience,
        },
        kid: 'config-test-1',
        issuer: 'open3dfarm:configuration-issuer',
        operation_id: op.operationId,
        committed_receipt_sha256: first.receiptSha256,
        committed_revision: 1,
        assignment_id: identity.assignment_id,
        printer_key: identity.printer_key,
      },
      f.now(),
    ),
    true,
  )
})

test('receipt registration rejects everything except current, matching, committed evidence', async () => {
  const f = await fixture()
  const session = await f.negotiate()
  const op = await f.committed(session)
  const deniedResult = { ok: false, reason: 'denied' }
  const local = (overrides: Record<string, unknown>, key?: CryptoKey) =>
    f.receipt(
      op.operationId,
      'local-committed',
      { prior_receipt_sha256: op.preparedSha256, ...overrides },
      key,
    )

  // Uncommitted evidence never registers.
  assert.deepEqual(await f.register(op.prepared), deniedResult)
  assert.deepEqual(
    await f.register(
      await f.receipt(op.operationId, 'recovery-required', {
        prior_receipt_sha256: op.preparedSha256,
        recovery_reason: 'commit-incomplete',
      }),
    ),
    deniedResult,
  )
  // Wrong signer, even when it claims the enrolled fingerprint or its own.
  assert.deepEqual(
    await f.register(await local({}, f.otherConnector.privateKey)),
    deniedResult,
  )
  const otherFingerprint = await connectorFingerprintFromSpki(
    await spkiOf(f.otherConnector.publicKey),
  )
  assert.deepEqual(
    await f.register(
      await local(
        { connector_fingerprint: otherFingerprint },
        f.otherConnector.privateKey,
      ),
    ),
    deniedResult,
  )
  // Tampered after signing.
  assert.deepEqual(
    await f.registration.register({
      sessionRecordId,
      farmId: ids.farm,
      request: {
        keyId: ids.key,
        receiptWire: canonicalize({
          ...op.local,
          issued_at: op.local.issued_at + 1,
        }),
      },
    }),
    deniedResult,
  )
  // Context, target, revision, chain and operation mismatches.
  for (const overrides of [
    { account_id: 'account-other' },
    { agent_id: randomUUID() },
    { operation_id: randomUUID() },
    { expected_revision: 1, committed_revision: 2 },
    { prior_receipt_sha256: digest() },
    {
      target: {
        target_sha256: digest(),
        device_id: target.device_id,
        bridge_instance_id: 'bridge-synthetic-1',
      },
    },
    { issued_at: f.now() + 60_000 },
    { issued_at: f.now() - 60_000 },
  ])
    assert.deepEqual(
      await f.register(await local(overrides)),
      deniedResult,
      JSON.stringify(overrides),
    )
  assert.deepEqual(
    await f.register(await local({ farm_id: randomUUID() })),
    deniedResult,
  )
  // Prepared but never admitted for commit.
  const operationId = randomUUID()
  const prepared = await f.capability(
    await f.challenge(session, {
      action: 'prepare',
      operationId,
      targetSha256: op.targetSha256,
    }),
  )
  assert.equal(prepared.result.ok, true)
  assert.deepEqual(
    await f.register(
      await f.receipt(operationId, 'local-committed', {
        prior_receipt_sha256: op.preparedSha256,
      }),
    ),
    deniedResult,
  )
  // Cross-session, other device, and current-permission loss.
  assert.deepEqual(await f.register(op.local, 'another-session'), deniedResult)
  assert.deepEqual(
    await f.register(op.local, sessionRecordId, randomUUID()),
    deniedResult,
  )
  for (const changed of [
    null,
    { ...f.authority, role: 'viewer' },
    { ...f.authority, account_id: 'account-other' },
  ]) {
    f.state.authority = changed
    assert.deepEqual(await f.register(op.local), deniedResult)
  }
  assert.equal(f.state.assignments.size, 0)
  assert.equal(f.state.receipts.size, 0)
  f.state.authority = f.authority
  assert.equal((await f.register(op.local)).ok, true)
  assert.deepEqual(
    await f.registration.register({
      sessionRecordId,
      farmId: ids.farm,
      request: { keyId: ids.key, receiptWire: '{"not":"a receipt"}' },
    }),
    { ok: false, reason: 'invalid-input' },
  )
})
