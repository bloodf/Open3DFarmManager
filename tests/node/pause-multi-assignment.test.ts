import test, { afterEach, beforeEach, mock } from 'node:test'
// Runtime request, staleness and backoff timers fire only when a test advances
// them, so a descheduled process cannot turn a loopback reply into a timeout.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())
import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import type { RuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  runPauseControl,
  type PauseControlDiagnostic,
} from '../../packages/connector/src/runtime/pause-control.ts'
import {
  createOfflineAuthority,
  type CachedAuthorityFreshness,
} from '../../packages/connector/src/auth/offline-authority.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import {
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  signPauseAdmissionProof,
  signPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

const ISSUER = 'farm:pause-issuer'
const KID = 'issuer-1'
const SIGNALLING = {
  endpoint: 'wss://farm.example/api/signalling/pause-connector',
  origin: 'https://farm.example',
  audience: 'pause-audience',
  credentialAudience: 'credential-audience',
}
const digest = () => randomBytes(32).toString('base64url')

// Timers are mocked per test, so this waits on events between event-loop
// turns. The test's own signal ends the wait when the test times out, so a
// timed-out body stops instead of spinning on.
async function waitFor(signal: AbortSignal, condition: () => boolean) {
  while (!condition()) {
    signal.throwIfAborted()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function token(jti: string) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return [part({ alg: 'EdDSA' }), part({ jti }), digest()].join('.')
}

/** Private runtime files, a loopback fake Moonraker and genuine signing keys. */
async function fixture(
  t: test.TestContext,
  options: {
    control?: boolean
    farmId?: string
    agentId?: string
    printerKey?: string
    kid?: string
    jti?: string
  } = {},
) {
  const printerKey = options.printerKey ?? 'printer-1'
  const kid = options.kid ?? KID
  const directory = mkdtempSync(join(tmpdir(), 'pause-control-runtime-'))
  const moonraker = await pauseFixture()
  t.after(async () => {
    await moonraker.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const issuerPair = generateKeyPairSync('ed25519')
  const issuerSpki = issuerPair.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url')
  // Production issuers sign with a nonextractable key.
  const issuerKey = await crypto.subtle.importKey(
    'pkcs8',
    issuerPair.privateKey.export({ format: 'der', type: 'pkcs8' }),
    'Ed25519',
    false,
    ['sign'],
  )
  const farmId = options.farmId ?? randomUUID()
  const agentId = options.agentId ?? randomUUID()
  const assignmentId = randomUUID()
  const jti = options.jti ?? randomUUID()
  const path = join(directory, 'runtime.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [moonraker.origin],
        printers: [{ printerKey, origin: moonraker.origin + '/' }],
        limits: {
          maxMessageBytes: 4096,
          connectTimeoutMs: 1500,
          requestTimeoutMs: 1500,
          staleAfterMs: 4000,
          reconnectMinMs: 100,
          reconnectMaxMs: 100,
        },
      },
      assignments: [
        {
          assignment_id: assignmentId,
          farm_id: farmId,
          agent_id: agentId,
          printer_key: printerKey,
          moonraker_origin: moonraker.origin,
        },
      ],
      telemetry: {
        endpoint: 'https://telemetry.example/api/connector/telemetry',
        audience: 'connector-audience',
      },
      pause: {
        version: 1,
        issuers: [{ issuer: ISSUER, kid, publicKeySpki: issuerSpki }],
        signalling: SIGNALLING,
        ...(options.control === false ? {} : { control: { assignmentId } }),
      },
    }),
    { mode: 0o600 },
  )
  const config = readAgentRuntimeConfig(path, {
    agent_id: agentId,
    farm_id: farmId,
  })
  const credential = {
    status: 'approved',
    agent_id: agentId,
    farm_id: farmId,
    device_token: token(jti),
    expires_at: Date.now() + 60000,
  } as unknown as RuntimeCredential
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )

  // Synthetic peer material for one control binding.
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const connectorSpki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const now = Date.now()
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: randomUUID(),
    farm_id: farmId,
    agent_id: agentId,
    account_id: 'operator_account',
    key_id: randomUUID(),
    assignment_id: assignmentId,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: connectorSpki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' +
      createHash('sha256').update(connectorSpki).digest('base64url'),
    credential_jti: jti,
    origin: SIGNALLING.origin,
    audience: SIGNALLING.audience,
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const capabilityId = randomUUID()
  const proofs = {
    binding,
    deadlineMonoMs: performance.now() + 30000,
    browserProofWire: encodeControlProof({
      v: 1,
      role: 'browser',
      binding,
      signature: await signControlSessionProof(
        binding,
        'browser',
        browser.privateKey,
      ),
    }),
    connectorProofWire: encodeControlProof({
      v: 1,
      role: 'connector',
      binding,
      signature: await signControlSessionProof(
        binding,
        'connector',
        connector.privateKey,
      ),
    }),
  }
  const bindingHash = await controlBindingHash(binding)

  async function admission(admissionNonce: string) {
    const issuedAt = Date.now()
    const capability = await signPauseCapability(
      {
        v: 1,
        purpose: 'pause-authority',
        capability_id: capabilityId,
        kid,
        issuer: ISSUER,
        audience: binding.audience,
        origin: binding.origin,
        issued_at: issuedAt,
        expires_at: Math.min(issuedAt + 30000, binding.expires_at),
        account_id: binding.account_id,
        role: 'operator',
        farm_id: farmId,
        agent_id: agentId,
        key_id: binding.key_id,
        assignment_id: assignmentId,
        transport_id: binding.transport_id,
        browser_public_key: publicKey,
        browser_thumbprint: thumbprint,
        connector_fingerprint: binding.connector_fingerprint,
        credential_jti: jti,
        printer_key: printerKey,
        control_binding_sha256: bindingHash,
        admission_nonce: admissionNonce,
        actions: ['pause'],
      },
      issuerKey,
    )
    const proof = await signPauseAdmissionProof(
      {
        v: 1,
        purpose: 'pause-admission',
        challenge_id: randomUUID(),
        farm_id: farmId,
        agent_id: agentId,
        key_id: binding.key_id,
        assignment_id: assignmentId,
        transport_id: binding.transport_id,
        account_id: binding.account_id,
        browser_thumbprint: thumbprint,
        origin: binding.origin,
        audience: binding.audience,
        control_binding_sha256: bindingHash,
        admission_nonce: admissionNonce,
        issued_at: issuedAt,
        expires_at: issuedAt + 8000,
      },
      browser.privateKey,
    )
    return {
      capabilityWire: encodePauseCapability(capability),
      admissionProofWire: encodePauseAdmissionProof(proof),
    }
  }
  async function commandWire() {
    return encodeCommandV2(await signedCommand())
  }
  async function signedCommand(cmdId: string = randomUUID()) {
    const issuedAt = Date.now()
    return await signCommandV2(
      {
        v: 2,
        purpose: 'printer-pause',
        cmd_id: cmdId,
        farm_id: farmId,
        agent_id: agentId,
        account_id: binding.account_id,
        key_id: binding.key_id,
        transport_id: binding.transport_id,
        capability_id: capabilityId,
        assignment_id: assignmentId,
        action: 'pause',
        args: {},
        issued_at: issuedAt,
        expires_at: issuedAt + 5000,
        nonce: randomBytes(16).toString('base64url'),
      },
      browser.privateKey,
    )
  }

  // Fake transport: records the exact scope and every send, never a socket.
  type Options = Parameters<
    NonNullable<Parameters<typeof runPauseControl>[0]['createClient']>
  >[1]
  const sessions: Array<{
    scope: Record<string, unknown>
    options: Options
    phases: Array<{ t: string; admission_nonce?: string }>
    results: Array<{ t: string; outcome: string }>
    closed: boolean
  }> = []
  const diagnostics: PauseControlDiagnostic[] = []
  let controller = new AbortController()
  let serverSeq = 0
  const createClient: NonNullable<
    Parameters<typeof runPauseControl>[0]['createClient']
  > = (scope, options) => {
    const session = {
      scope: { ...scope },
      options,
      phases: [] as Array<{ t: string; admission_nonce?: string }>,
      results: [] as Array<{ t: string; outcome: string }>,
      closed: false,
    }
    sessions.push(session)
    return {
      start: () => Promise.resolve(),
      close: () => {
        session.closed = true
      },
      dispose: () => Promise.resolve(),
      sendPhase: (message) => {
        session.phases.push(message as (typeof session.phases)[number])
        return true
      },
      sendResult: (result) => {
        session.results.push(result)
        return true
      },
    }
  }
  /**
   * Starts one runtime owner on the shared data directory. `fresh` confirms a
   * real offline authority tracker, standing in for the authenticated server
   * confirmation; without it authority stays stale like production today.
   */
  function start(
    options: {
      fresh?: boolean
      freshness?: CachedAuthorityFreshness
      config?: typeof config
      clientFor?: NonNullable<
        Parameters<typeof runPauseControl>[0]['createClient']
      >
    } = {},
  ) {
    sessions.length = 0
    diagnostics.length = 0
    controller = new AbortController()
    const offline = createOfflineAuthority()
    if (options.fresh !== false)
      offline.confirm(
        { wall: Date.now(), mono: performance.now() },
        ++serverSeq,
      )
    return runPauseControl({
      config: options.config ?? config,
      credential,
      identity,
      dataDirectory: directory,
      signal: controller.signal,
      freshness: options.freshness ?? offline.freshness,
      onDiagnostic: (value) => diagnostics.push(value),
      createClient: options.clientFor ?? createClient,
    })
  }
  /** Drives proofs, both admission halves and one command through the session. */
  async function admitAndCommand(
    wire?: string | (() => Promise<string>),
    options: { admitted?: boolean } = {},
  ) {
    await waitFor(t.signal, () => sessions.length === 1)
    const session = sessions[0]!
    session.options.onInboxReady?.()
    session.options.onProofsReady?.(proofs)
    await waitFor(t.signal, () => session.phases.length === 1)
    const nonce = session.phases[0]!.admission_nonce!
    const issued = await admission(nonce)
    const frame = (t: string, value: string) =>
      Object.freeze({
        v: 1,
        t,
        transport_id: binding.transport_id,
        seq: 0,
        wire: value,
      }) as never
    session.options.onPhase?.(
      frame('control.capability', issued.capabilityWire),
    )
    session.options.onPhase?.(
      frame('control.admission-proof', issued.admissionProofWire),
    )
    const command =
      typeof wire === 'function'
        ? await wire()
        : (wire ?? (await commandWire()))
    session.options.onData?.(frame('control.command', command))
    return { session, command, frame }
  }
  return {
    config,
    path,
    credential,
    identity,
    createClient,
    proofs,
    journalDirectory: join(directory, 'pause-journal'),
    directory,
    moonraker,
    assignmentId,
    jti,
    sessions,
    diagnostics,
    get controller() {
      return controller
    },
    signedCommand,
    start,
    admitAndCommand,
  }
}

async function multiFixture(t: test.TestContext) {
  const a = await fixture(t)
  const b = await fixture(t, {
    farmId: a.credential.farm_id,
    agentId: a.credential.agent_id,
    printerKey: 'printer-2',
    kid: 'issuer-2',
    jti: a.jti,
  })
  const rawA = JSON.parse(readFileSync(a.path, 'utf8'))
  const rawB = JSON.parse(readFileSync(b.path, 'utf8'))
  const raw = {
    ...rawA,
    collection: {
      ...rawA.collection,
      allowedOrigins: [
        ...rawA.collection.allowedOrigins,
        ...rawB.collection.allowedOrigins,
      ],
      printers: [...rawA.collection.printers, ...rawB.collection.printers],
    },
    assignments: [...rawA.assignments, ...rawB.assignments],
    pause: {
      ...rawA.pause,
      issuers: [
        ...rawA.pause.issuers,
        { ...rawB.pause.issuers[0], kid: 'issuer-2' },
      ],
      control: { assignmentIds: [a.assignmentId, b.assignmentId] },
    },
  }
  writeFileSync(a.path, JSON.stringify(raw), { mode: 0o600 })
  const read = () => readAgentRuntimeConfig(a.path, a.credential)
  return { a, b, raw, read }
}

test('multiple assignments validate and unknown, duplicate and empty selections fail', async (t) => {
  const { a, raw, read } = await multiFixture(t)
  assert.equal(read().pause?.control?.assignmentIds.length, 2)
  for (const ids of [
    [randomUUID()],
    [raw.pause.control.assignmentIds[0], randomUUID()],
  ]) {
    raw.pause.control.assignmentIds = ids
    writeFileSync(a.path, JSON.stringify(raw))
    assert.throws(read, /not provisioned locally/)
  }
  for (const ids of [[], [a.assignmentId, a.assignmentId], ['invalid']]) {
    raw.pause.control.assignmentIds = ids
    writeFileSync(a.path, JSON.stringify(raw))
    assert.throws(read)
  }
})

test(
  'legacy single-assignment config migrates and still pauses its simulated printer',
  { timeout: 15000 },
  async (t) => {
    const a = await fixture(t)
    assert.deepEqual(a.config.pause?.control, {
      assignmentIds: [a.assignmentId],
    })
    const raw = JSON.parse(readFileSync(a.path, 'utf8'))
    for (const schemaVersion of [1, 2]) {
      writeFileSync(a.path, JSON.stringify({ ...raw, schemaVersion }))
      assert.deepEqual(
        readAgentRuntimeConfig(a.path, a.credential).pause?.control,
        {
          assignmentIds: [a.assignmentId],
        },
      )
    }
    const running = a.start()
    t.after(async () => {
      a.controller.abort()
      await running
    })
    const { session } = await a.admitAndCommand()
    await waitFor(t.signal, () => session.results.length === 1)
    assert.equal(session.results[0]!.outcome, 'applied')
    assert.equal(a.moonraker.counts().pauses, 1)
  },
)

test(
  'two simulated printers accept only their own signed control',
  { timeout: 15000 },
  async (t) => {
    const { a, b, read } = await multiFixture(t)
    const running = a.start({
      config: read(),
      clientFor(scope, options) {
        return scope.assignmentId === a.assignmentId
          ? a.createClient(scope, options)
          : b.createClient(scope, options)
      },
    })
    t.after(async () => {
      a.controller.abort()
      await running
    })
    const first = await a.admitAndCommand()
    await waitFor(t.signal, () => first.session.results.length === 1)
    assert.equal(first.session.results[0]!.outcome, 'applied')
    assert.equal(a.moonraker.counts().pauses, 1)
    assert.equal(b.moonraker.counts().pauses, 0)
    const second = await b.admitAndCommand()
    await waitFor(t.signal, () => second.session.results.length === 1)
    assert.equal(second.session.results[0]!.outcome, 'applied')
    assert.equal(a.moonraker.counts().pauses, 1)
    assert.equal(b.moonraker.counts().pauses, 1)
    a.controller.abort()
    await running
    assert.equal(first.session.closed, true)
    assert.equal(second.session.closed, true)
    const db = new DatabaseSync(
      join(a.directory, 'pause-journal', 'pause-commands.sqlite'),
      { readOnly: true },
    )
    try {
      assert.deepEqual(
        db
          .prepare(
            'SELECT assignment_id FROM pause_commands ORDER BY assignment_id',
          )
          .all()
          .map((row) => row.assignment_id),
        [a.assignmentId, b.assignmentId].sort(),
      )
    } finally {
      db.close()
    }
  },
)

test(
  'a signed A command on a fresh B peer is rejected before either driver runs',
  { timeout: 15000 },
  async (t) => {
    const { a, b, read } = await multiFixture(t)
    const running = a.start({
      config: read(),
      clientFor(scope, options) {
        return scope.assignmentId === a.assignmentId
          ? a.createClient(scope, options)
          : b.createClient(scope, options)
      },
    })
    t.after(async () => {
      a.controller.abort()
      await running
    })
    const { session } = await b.admitAndCommand(
      encodeCommandV2(await a.signedCommand()),
    )
    await waitFor(t.signal, () => session.results.length === 1)
    assert.equal(session.results[0]!.outcome, 'rejected')
    assert.equal(a.moonraker.counts().pauses, 0)
    assert.equal(b.moonraker.counts().pauses, 0)
    assert.equal(a.moonraker.counts().connections, 0)
    assert.equal(b.moonraker.counts().connections, 0)
  },
)
