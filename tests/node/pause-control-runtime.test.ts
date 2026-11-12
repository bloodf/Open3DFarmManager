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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import type { RuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  pauseFailureReason,
  runPauseControl,
  type PauseControlDiagnostic,
} from '../../packages/connector/src/runtime/pause-control.ts'
import {
  createOfflineAuthority,
  type CachedAuthorityFreshness,
} from '../../packages/connector/src/auth/offline-authority.ts'
import {
  claimCommand,
  closeCommandJournal,
  markWriteStarted,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseCommandRelay } from '../../packages/connector/src/control/pause-command-relay.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import {
  decodeCommandV2,
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

function journalRows(directory: string) {
  const database = new DatabaseSync(join(directory, 'pause-commands.sqlite'), {
    readOnly: true,
    allowExtension: false,
  })
  try {
    return database
      .prepare('SELECT status FROM pause_commands ORDER BY claimed_at')
      .all()
      .map((row) => row.status)
  } finally {
    database.close()
  }
}

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
  options: { control?: boolean } = {},
) {
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
  const farmId = randomUUID()
  const agentId = randomUUID()
  const assignmentId = randomUUID()
  const jti = randomUUID()
  const path = join(directory, 'runtime.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [moonraker.origin],
        printers: [{ printerKey: 'printer-1', origin: moonraker.origin + '/' }],
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
          printer_key: 'printer-1',
          moonraker_origin: moonraker.origin,
        },
      ],
      telemetry: {
        endpoint: 'https://telemetry.example/api/connector/telemetry',
        audience: 'connector-audience',
      },
      pause: {
        version: 1,
        issuers: [{ issuer: ISSUER, kid: KID, publicKeySpki: issuerSpki }],
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
        kid: KID,
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
        printer_key: 'printer-1',
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
  /**
   * Starts one runtime owner on the shared data directory. `fresh` confirms a
   * real offline authority tracker, standing in for the authenticated server
   * confirmation; without it authority stays stale like production today.
   */
  function start(
    options: { fresh?: boolean; freshness?: CachedAuthorityFreshness } = {},
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
      config,
      credential,
      identity,
      dataDirectory: directory,
      signal: controller.signal,
      freshness: options.freshness ?? offline.freshness,
      onDiagnostic: (value) => diagnostics.push(value),
      createClient(scope, options) {
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
      },
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
    await waitFor(t.signal, () =>
      diagnostics.some(
        (d) =>
          d.kind ===
          (options.admitted === false ? 'pause-denied' : 'pause-admitted'),
      ),
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

test('pause control is disabled unless the pause section names a control assignment', async (t) => {
  const f = await fixture(t, { control: false })
  assert.equal(f.config.pause?.control, undefined)
  await assert.rejects(f.start(), /Pause control is not enabled/)
  assert.equal(f.sessions.length, 0)
})

test('a control assignment that is not provisioned locally is refused at startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pause-control-config-'))
  try {
    const farm = randomUUID()
    const agent = randomUUID()
    const origin = 'http://127.0.0.1:9'
    const path = join(directory, 'runtime.json')
    const issuer = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [origin],
          printers: [{ printerKey: 'printer-1', origin: origin + '/' }],
        },
        assignments: [
          {
            assignment_id: randomUUID(),
            farm_id: farm,
            agent_id: agent,
            printer_key: 'printer-1',
            moonraker_origin: origin,
          },
        ],
        telemetry: {
          endpoint: 'https://telemetry.example/api/connector/telemetry',
          audience: 'connector-audience',
        },
        pause: {
          version: 1,
          issuers: [
            {
              issuer: ISSUER,
              kid: KID,
              publicKeySpki: Buffer.from(
                await crypto.subtle.exportKey('spki', issuer.publicKey),
              ).toString('base64url'),
            },
          ],
          signalling: SIGNALLING,
          control: { assignmentId: randomUUID() },
        },
      }),
      { mode: 0o600 },
    )
    assert.throws(
      () => readAgentRuntimeConfig(path, { agent_id: agent, farm_id: farm }),
      /Pause control assignment is not provisioned locally/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an admitted signed pause reaches the fake Moonraker once, is journaled and is never retried', async (t) => {
  const f = await fixture(t)
  const running = f.start()
  const { session, command, frame } = await f.admitAndCommand()
  assert.equal(session.scope.url, SIGNALLING.endpoint)
  assert.equal(session.scope.audience, SIGNALLING.audience)
  assert.equal(session.scope.credentialAudience, SIGNALLING.credentialAudience)
  assert.equal(session.scope.assignmentId, f.assignmentId)
  assert.equal(session.scope.jti, f.jti)
  await waitFor(t.signal, () => session.results.length === 1)
  assert.equal(session.results[0]!.outcome, 'applied')
  assert.equal(f.moonraker.counts().pauses, 1)
  // A repeated command on the same peer answers the first outcome and never
  // reaches the printer again.
  session.options.onData?.(frame('control.command', command))
  await waitFor(
    t.signal,
    () => f.diagnostics.filter((d) => d.kind === 'pause-outcome').length === 2,
  )
  assert.equal(f.moonraker.counts().pauses, 1)
  assert.ok(
    f.moonraker.requests.every(
      (request) => request.method !== 'printer.print.resume',
    ),
  )
  f.controller.abort()
  await running
  assert.equal(session.closed, true)
  assert.deepEqual(
    f.diagnostics.filter((d) => d.kind === 'pause-outcome'),
    [
      { kind: 'pause-outcome', outcome: 'applied', reason: 'applied' },
      { kind: 'pause-outcome', outcome: 'applied', reason: 'applied' },
    ],
  )
  // The local audit journal holds exactly one applied record for the command.
  const database = new DatabaseSync(
    join(f.journalDirectory, 'pause-commands.sqlite'),
    { readOnly: true, allowExtension: false },
  )
  try {
    const rows = database
      .prepare('SELECT status, assignment_id FROM pause_commands')
      .all()
      .map((row) => ({ ...row }))
    assert.deepEqual(rows, [
      { status: 'applied', assignment_id: f.assignmentId },
    ])
  } finally {
    database.close()
  }
})

test('without an authenticated confirmation the production path is inert: every command is rejected stale', async (t) => {
  const f = await fixture(t)
  const running = f.start({ fresh: false })
  const { session } = await f.admitAndCommand(undefined, { admitted: false })
  assert.ok(
    f.diagnostics.some(
      (d) => d.kind === 'pause-denied' && d.reason === 'expired-or-inactive',
    ),
  )
  await waitFor(t.signal, () => session.results.length === 1)
  assert.equal(session.results[0]!.outcome, 'rejected')
  assert.equal(f.moonraker.counts().connections, 0)
  assert.equal(f.moonraker.counts().pauses, 0)
  f.controller.abort()
  await running
})

test('the relay refuses to start without a callable freshness gate', () => {
  for (const freshness of [undefined, {}, { freshAt: true }])
    assert.throws(
      () =>
        createPauseCommandRelay({
          authority: { issuers: [], freshness: freshness as never },
          clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
          journal: {} as never,
          driver: {} as never,
          bindingFor: () => undefined,
        }),
      /freshness gate/,
    )
})

test('after an applied pause and a restart on the same data directory the command is a replay and never reaches the printer again', async (t) => {
  const f = await fixture(t)
  const first = f.start()
  const { command } = await f.admitAndCommand()
  await waitFor(t.signal, () => f.sessions[0]!.results.length === 1)
  assert.equal(f.sessions[0]!.results[0]!.outcome, 'applied')
  f.controller.abort()
  await first
  assert.equal(f.moonraker.counts().pauses, 1)
  // Restart: new relay, journal and tracker on the same data directory.
  const second = f.start()
  // Same command id, freshly signed for the new peer and capability, so every
  // earlier check passes and only the journal can refuse it.
  const { session } = await f.admitAndCommand(async () =>
    encodeCommandV2(await f.signedCommand(decodeCommandV2(command).cmd_id)),
  )
  await waitFor(t.signal, () => session.results.length === 1)
  assert.equal(session.results[0]!.outcome, 'rejected')
  // The rejection comes from the durable journal's replay refusal.
  await waitFor(t.signal, () =>
    f.diagnostics.some((d) => d.kind === 'pause-outcome'),
  )
  assert.deepEqual(
    f.diagnostics.filter((d) => d.kind === 'pause-outcome'),
    [{ kind: 'pause-outcome', outcome: 'rejected', reason: 'replay' }],
  )
  assert.equal(f.moonraker.counts().pauses, 1)
  f.controller.abort()
  await second
  assert.deepEqual(journalRows(f.journalDirectory), ['applied'])
})

test('a leftover write-started row from a crash keeps the assignment busy and no command reaches the printer', async (t) => {
  const f = await fixture(t)
  // Simulate a crash between the write mark and the outcome.
  const journal = openCommandJournal({
    directory: f.journalDirectory,
    clock: Date.now,
  })
  const crashed = await f.signedCommand()
  const claim = claimCommand(journal, {
    command: crashed,
    printerKey: 'printer-1',
    wireSha256: createHash('sha256')
      .update(encodeCommandV2(crashed))
      .digest('hex'),
  })
  assert.equal(claim.ok, true)
  if (claim.ok) assert.equal(markWriteStarted(journal, claim.receipt), true)
  closeCommandJournal(journal)
  const running = f.start()
  const { session } = await f.admitAndCommand()
  await waitFor(t.signal, () => session.results.length === 1)
  assert.equal(session.results[0]!.outcome, 'rejected')
  assert.equal(f.moonraker.counts().connections, 0)
  assert.equal(f.moonraker.counts().pauses, 0)
  f.controller.abort()
  await running
  assert.deepEqual(
    f.diagnostics.filter((d) => d.kind === 'pause-outcome'),
    [{ kind: 'pause-outcome', outcome: 'rejected', reason: 'busy' }],
  )
  // Only the crashed row exists: the new command was refused before a claim.
  assert.deepEqual(journalRows(f.journalDirectory), ['write-started'])
})

test('a terminal transport closes the peer before any command and the lifecycle reconnects', async (t) => {
  const f = await fixture(t)
  const running = f.start()
  await waitFor(t.signal, () => f.sessions.length === 1)
  const first = f.sessions[0]!
  first.options.onProofsReady?.(f.proofs)
  await waitFor(t.signal, () => first.phases.length === 1)
  first.options.onTerminal?.('socket-closed')
  assert.ok(
    f.diagnostics.some(
      (d) => d.kind === 'pause-terminal' && d.reason === 'socket-closed',
    ),
  )
  // A late command for the closed peer is refused and never dispatched.
  first.options.onData?.(
    Object.freeze({
      v: 1,
      t: 'control.command',
      transport_id: f.proofs.binding.transport_id,
      seq: 0,
      wire: 'x',
    }) as never,
  )
  // The reconnect waits on the lifecycle's backoff timer; advance it explicitly.
  while (f.sessions.length !== 2) {
    mock.timers.tick(100)
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(first.closed, true)
  assert.equal(f.moonraker.counts().connections, 0)
  f.controller.abort()
  await running
  // The journal was released: a fresh owner can open the same directory.
  const { openCommandJournal, closeCommandJournal } =
    await import('../../packages/connector/src/control/command-journal.ts')
  closeCommandJournal(
    openCommandJournal({ directory: f.journalDirectory, clock: Date.now }),
  )
})

test('a relay construction failure releases the journal and is classified without free text', async (t) => {
  const f = await fixture(t)
  const error = await f
    .start({ freshness: {} as CachedAuthorityFreshness })
    .then(
      () => undefined,
      (value: unknown) => value,
    )
  assert.ok(error instanceof Error)
  assert.equal(pauseFailureReason(error), 'runtime')
  assert.equal(pauseFailureReason(new Error('anything')), 'runtime')
  // The journal was closed: a fresh owner can open the same directory.
  closeCommandJournal(
    openCommandJournal({ directory: f.journalDirectory, clock: Date.now }),
  )
})

test('an unusable journal directory fails with the fixed journal reason', async (t) => {
  const f = await fixture(t)
  writeFileSync(f.journalDirectory, 'not a directory', { mode: 0o600 })
  const error = await f.start().then(
    () => undefined,
    (value: unknown) => value,
  )
  assert.equal(pauseFailureReason(error), 'journal')
})
