import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseCommandRelay } from '../../packages/connector/src/control/pause-command-relay.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  signPauseCapability,
  encodePauseCapability,
  signPauseAdmissionProof,
  encodePauseAdmissionProof,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  createPauseExecutionRtcFixtureExtension,
  verifyPauseExecutionAcceptance,
  verifyPauseExecutionRevocation,
  verifyPauseExecutionDegradation,
  PauseExecutionNativeObservation,
  PauseExecutionBrowserObservation,
} from '../helpers/pause-execution-rtc.ts'
import {
  parsePauseExecutionRtcCommand,
  PauseExecutionRtcReply,
  createPauseExecutionRtcProgress,
  PAUSE_EXECUTION_RTC_IPC_BYTES,
} from '../helpers/pause-execution-rtc-connector-child.ts'

function observations() {
  const commandId = randomUUID()
  const transportId = randomUUID()
  const progress = createPauseExecutionRtcProgress()
  progress.advance('command-settled')

  const native: PauseExecutionNativeObservation = Object.freeze({
    kind: 'observation',
    inboxReady: true,
    proofsReady: true,
    capabilityAccepted: true,
    commandReceived: true,
    commandsReceived: 1,
    pausesObserved: 1,
    latestPrintState: 'paused',
    commandId,
    transportId,
    commandOutcome: 'applied',
    terminal: false,
    failed: false,
    diagnostics: Object.freeze({
      certificateMatched: true,
      sentProofs: 1,
      receivedProofs: 1,
      terminal: false,
      commandsEnabled: true as const,
    }),
    relayDiagnostics: Object.freeze({
      peers: 1,
      admitted: 1,
      commands: 1,
      rejected: 0,
      notSent: 0,
      applied: 1,
      outcomeUnknown: 0,
      unsentResults: 0,
      expired: 0,
      pending: 0,
      closed: false,
      lastReason: 'applied',
    }),
    progress: progress.snapshot(),
  })

  const browser: PauseExecutionBrowserObservation = Object.freeze({
    terminal: false,
    failed: false,
    proofsReady: true,
    admitted: true,
    commandSent: true,
    commandHttpRequests: 0,
    outcome: 'applied',
    commandReceipt: Object.freeze({
      commandId,
      transportId,
      outcome: 'applied',
    }),
    diagnostics: Object.freeze({
      certificateMatched: true,
      sentProofs: 1,
      receivedProofs: 1,
      terminal: false,
      commandsEnabled: false,
    }),
  })

  return { native, browser, commandId, transportId }
}

test('verifyPauseExecutionAcceptance accepts correlated execution observation with matching IDs, 1 pause, and applied outcome', () => {
  const { native, browser, commandId, transportId } = observations()
  assert.doesNotThrow(() =>
    verifyPauseExecutionAcceptance(native, browser, {
      expectedCommandId: commandId,
      expectedTransportId: transportId,
    }),
  )
})

test('native capabilityAccepted alone must fail execution acceptance', () => {
  const { native, browser } = observations()

  // Zero simulator pauses observed
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        { ...native, pausesObserved: 0 },
        browser,
      ),
    /exactly one printer\.print\.pause/,
  )

  // Command not received by native
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        { ...native, commandReceived: false },
        browser,
      ),
    /must observe command receipt/,
  )

  // Print state not paused
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        { ...native, latestPrintState: 'printing' },
        browser,
      ),
    /fresh paused state/,
  )

  // Browser not admitted or command not sent
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        native,
        { ...browser, commandSent: false },
      ),
    /command must be sent/,
  )
})

test('replaying or multiple simulator pauses must fail execution acceptance', () => {
  const { native, browser } = observations()
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        { ...native, pausesObserved: 2 },
        browser,
      ),
    /exactly one printer\.print\.pause/,
  )
})

test('mismatched commandId or transportId fails execution acceptance', () => {
  const { native, browser, commandId, transportId } = observations()

  // Foreign command ID in native
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        { ...native, commandId: randomUUID() },
        browser,
      ),
    /command IDs must match/,
  )

  // Foreign transport ID in browser receipt
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(native, {
        ...browser,
        commandReceipt: {
          ...browser.commandReceipt!,
          transportId: randomUUID(),
        },
      }),
    /transport IDs must match/,
  )

  // Expected ID mismatch option
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(native, browser, {
        expectedCommandId: randomUUID(),
        expectedTransportId: transportId,
      }),
    /Command ID must match expected/,
  )
})

test('unsettled, non-applied, or failed outcome fails execution acceptance', () => {
  const { native, browser } = observations()

  for (const outcome of ['rejected', 'outcome-unknown', null] as const) {
    assert.throws(
      () =>
        verifyPauseExecutionAcceptance(native, {
          ...browser,
          outcome,
          commandReceipt: outcome
            ? { ...browser.commandReceipt!, outcome }
            : null,
        }),
      /Browser outcome must be applied/,
    )
  }

  for (const patch of [{ failed: true }, { terminal: true }]) {
    assert.throws(() =>
      verifyPauseExecutionAcceptance({ ...native, ...patch }, browser),
    )
    assert.throws(() =>
      verifyPauseExecutionAcceptance(native, { ...browser, ...patch }),
    )
  }
})

test('execution actor diagnostics must report commandsEnabled: true', () => {
  const { native, browser } = observations()
  assert.throws(
    () =>
      verifyPauseExecutionAcceptance(
        {
          ...native,
          diagnostics: { ...native.diagnostics, commandsEnabled: false },
        },
        browser,
      ),
    /commandsEnabled/,
  )
})

for (const row of ['fresh', 'revoked', 'stale', 'reassigned', 'peer-closed'] as const) {
test(`signed relay composition: ${row}`, async (t) => {
  const cleanup: Array<() => Promise<void> | void> = []
  t.after(async () => {
    for (const dispose of cleanup.reverse()) {
      await dispose()
    }
  })

  let wallOffset = 0
  const peerAbort = new AbortController()
  // 1. Keys and identities
  const browserKey = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuerKey = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connectorKey = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])

  const jwk = await crypto.subtle.exportKey('jwk', browserKey.publicKey)
  const { publicKey: browserPublicJwk, thumbprint } =
    await validateBrowserDevicePublicKey({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    })

  const transportId = randomUUID()
  const assignmentId = randomUUID()
  const farmId = randomUUID()
  const agentId = randomUUID()
  const keyId = randomUUID()
  const printerKey = 'test-exec-printer-key'
  const origin = 'https://127.0.0.1:4443'
  const audience = 'open3dfarmmanager:pause'
  const now = Date.now()

  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: transportId,
    farm_id: farmId,
    agent_id: agentId,
    account_id: 'user_exec_account',
    key_id: keyId,
    assignment_id: assignmentId,
    origin,
    audience,
    browser_public_key: browserPublicJwk,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: Buffer.from(await crypto.subtle.exportKey('spki', connectorKey.publicKey)).toString('base64url'),
    connector_fingerprint: 'SHA256:' + createHash('sha256').update(Buffer.from(await crypto.subtle.exportKey('spki', connectorKey.publicKey))).digest('base64url'),
    browser_nonce: randomBytes(32).toString('base64url'),
    connector_nonce: randomBytes(32).toString('base64url'),
    offer_sha256: randomBytes(32).toString('base64url'),
    answer_sha256: randomBytes(32).toString('base64url'),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
    credential_jti: randomUUID(),
    issued_at: now,
    expires_at: now + 30000,
  }

  // 2. Mock Moonraker loopback fixture
  const remote = await pauseFixture()
  cleanup.push(() => remote.close())

  // 3. Command journal
  const journalDir = mkdtempSync(join(tmpdir(), 'pause-exec-test-journal-'))
  cleanup.push(() => rmSync(journalDir, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory: journalDir, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))

  // 4. Printer binding and pause driver
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  })
  const printerBinding = registry.provision({
    assignment_id: assignmentId,
    farm_id: farmId,
    agent_id: agentId,
    printer_key: printerKey,
    moonraker_origin: remote.origin,
  })

  let dispatcherRef: ReturnType<typeof createPauseCommandRelay> | undefined
  const driver = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 3000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    clock: { monotonicNow: () => performance.now() },
    observe: (binding, obs) => dispatcherRef?.observe(binding, obs) ?? false,
  })

  // 5. Compose relay
  const relay = createPauseCommandRelay({
    authority: {
      issuers: [
        {
          issuer: 'farm:issuer',
          kid: 'test-kid',
          publicKey: issuerKey.publicKey,
        },
      ],
    },
    clock: { wallNow: () => Date.now() + wallOffset, monotonicNow: () => performance.now() },
    journal,
    driver,
    bindingFor: (id) => (id === assignmentId ? printerBinding : undefined),
  })
  dispatcherRef = relay
  cleanup.push(async () => {
    relay.close()
    await relay.settled
  })


  // 6. Generate control proofs and admit peer
  const browserProofWire = encodeControlProof({
    v: 1,
    role: 'browser',
    binding,
    signature: await signControlSessionProof(binding, 'browser', browserKey.privateKey),
  })
  const connectorProofWire = encodeControlProof({
    v: 1,
    role: 'connector',
    binding,
    signature: await signControlSessionProof(binding, 'connector', connectorKey.privateKey),
  })

  let admissionNonce = ''
  const opened = relay.openPeer({
    binding,
    browserProofWire,
    connectorProofWire,
    sendPhase: (m) => {
      if (m.t === 'control.admission-nonce') {
        admissionNonce = m.admission_nonce
      }
      return true
    },
    sendResult: () => true,
    signal: peerAbort.signal,
  })
  assert.equal(opened, true)
  assert.ok(admissionNonce.length > 0)

  // 7. Sign capability and admission proof
  const admittedAt = Date.now()
  const capability = await signPauseCapability(
    {
      v: 1,
      purpose: 'pause-authority',
      capability_id: randomUUID(),
      kid: 'test-kid',
      issuer: 'farm:issuer',
      audience,
      origin,
      issued_at: admittedAt,
      expires_at: admittedAt + 20000,
      account_id: binding.account_id,
      role: 'operator',
      farm_id: farmId,
      agent_id: agentId,
      key_id: keyId,
      assignment_id: assignmentId,
      transport_id: transportId,
      browser_public_key: browserPublicJwk,
      browser_thumbprint: thumbprint,
      connector_fingerprint: binding.connector_fingerprint,
      credential_jti: binding.credential_jti,
      printer_key: printerKey,
      control_binding_sha256: await controlBindingHash(binding),
      admission_nonce: admissionNonce,
      actions: ['pause'],
    },
    issuerKey.privateKey,
  )

  const admissionProof = await signPauseAdmissionProof(
    {
      v: 1,
      purpose: 'pause-admission',
      challenge_id: randomUUID(),
      farm_id: farmId,
      agent_id: agentId,
      key_id: keyId,
      assignment_id: assignmentId,
      transport_id: transportId,
      account_id: binding.account_id,
      browser_thumbprint: thumbprint,
      origin,
      audience,
      control_binding_sha256: await controlBindingHash(binding),
      admission_nonce: admissionNonce,
      issued_at: admittedAt,
      expires_at: admittedAt + 8000,
    },
    browserKey.privateKey,
  )

  const admitted = await relay.admitPeer({
    transportId,
    capabilityWire: encodePauseCapability(capability),
    admissionProofWire: encodePauseAdmissionProof(admissionProof),
  })
  assert.deepEqual(admitted, { ok: true })

  // 8. Sign command v2
  const cmdId = randomUUID()
  const commandAt = Date.now()
  const signedCommand = await signCommandV2(
    {
      v: 2,
      purpose: 'printer-pause',
      cmd_id: cmdId,
      farm_id: farmId,
      agent_id: agentId,
      account_id: binding.account_id,
      key_id: keyId,
      transport_id: transportId,
      capability_id: capability.capability_id,
      assignment_id: assignmentId,
      action: 'pause',
      args: {},
      issued_at: commandAt,
      expires_at: commandAt + 5000,
      nonce: randomBytes(16).toString('base64url'),
    },
    browserKey.privateKey,
  )
  const commandWire = encodeCommandV2(signedCommand)

  // Mutations happen after real signatures/admission, before any preparation.
  if (row === 'revoked') relay.closePeer(transportId)
  if (row === 'stale') wallOffset = 60000
  if (row === 'reassigned') registry.retire(printerBinding)
  if (row === 'peer-closed') peerAbort.abort()
  if (row !== 'fresh') {
    assert.notEqual(await relay.commandPeer({ transportId, wire: commandWire }), 'applied')
    assert.equal(remote.counts().connections, 0)
    assert.equal(remote.counts().queries, 0)
    assert.equal(remote.counts().pauses, 0)
    return
  }

  // 9. Dispatch command: should execute pause RPC and persist 'applied'
  const firstOutcome = await relay.commandPeer({
    transportId,
    wire: commandWire,
  })
  assert.equal(firstOutcome, 'applied')
  assert.equal(remote.counts().pauses, 1, 'Moonraker must observe 1 pause')
  assert.equal(readCommandOutcome(journal, cmdId)?.status, 'applied')

  // 10. Replay same command wire: must yield no second simulator request
  const replayOutcome = await relay.commandPeer({
    transportId,
    wire: commandWire,
  })
  assert.equal(
    replayOutcome,
    'applied',
    'Replaying on same peer returns cached outcome',
  )
  assert.equal(
    remote.counts().pauses,
    1,
    'Replaying must not execute second Moonraker pause RPC',
  )

  // 11. Durable journal persistence verified after reopen
  const reopened = openCommandJournal({
    directory: journalDir,
    clock: Date.now,
  })
  try {
    assert.equal(readCommandOutcome(reopened, cmdId)?.status, 'applied')
  } finally {
    closeCommandJournal(reopened)
  }
})

}

test('revocation verifier rejects unsafe synthetic observations', () => {
  const { native, browser } = observations()
  const revokedNative: PauseExecutionNativeObservation = {
    ...native,
    pausesObserved: 0,
    terminal: true,
    latestPrintState: 'printing',
    commandReceived: false,
    commandOutcome: null,
  }
  const revokedBrowser: PauseExecutionBrowserObservation = {
    ...browser,
    terminal: true,
    outcome: 'rejected',
    commandReceipt: null,
  }

  assert.doesNotThrow(() =>
    verifyPauseExecutionRevocation(revokedNative, revokedBrowser),
  )

  // If simulator observed a pause, verification must throw
  assert.throws(
    () =>
      verifyPauseExecutionRevocation(
        { ...revokedNative, pausesObserved: 1 },
        revokedBrowser,
      ),
    /Zero pause calls must reach simulator/,
  )

  // If outcome was applied despite revocation, verification must throw
  assert.throws(
    () =>
      verifyPauseExecutionRevocation(revokedNative, {
        ...revokedBrowser,
        outcome: 'applied',
      }),
    /Revocation must prevent applied outcome/,
  )
})

test('degradation verifier rejects unsafe synthetic observations', () => {
  const { native, browser } = observations()
  const degradedNative: PauseExecutionNativeObservation = {
    ...native,
    pausesObserved: 0,
    terminal: true,
    latestPrintState: 'printing',
    commandReceived: false,
    commandOutcome: null,
  }
  const degradedBrowser: PauseExecutionBrowserObservation = {
    ...browser,
    terminal: true,
    outcome: 'outcome-unknown',
    commandReceipt: null,
  }

  assert.doesNotThrow(() =>
    verifyPauseExecutionDegradation(degradedNative, degradedBrowser, {
      commands: 0,
    }),
  )

  // If any command HTTP request occurred, verification must throw
  assert.throws(
    () =>
      verifyPauseExecutionDegradation(degradedNative, degradedBrowser, {
        commands: 1,
      }),
    /Command bytes must travel exclusively via RTC/,
  )
})

test('private execution child IPC protocol strictly validates commands and rejects unauthorized fields', () => {
  assert.deepEqual(parsePauseExecutionRtcCommand('{"kind":"observe"}'), {
    kind: 'observe',
  })
  assert.throws(() => parsePauseExecutionRtcCommand('{"kind":"replay","wire":"sample-wire"}'))

  for (const command of [
    { kind: 'admit', binding: {} },
    { kind: 'proof', signature: 'unauthorized' },
    { kind: 'capability', wire: 'unauthorized' },
    { kind: 'answer', sdp: 'unauthorized' },
    { kind: 'pause' },
    { kind: 'observe', token: 'leak' },
    { kind: 'replay', wire: '' },
    { kind: 'replay', wire: 'x'.repeat(8193) },
  ]) {
    assert.throws(() => parsePauseExecutionRtcCommand(JSON.stringify(command)))
  }

  assert.throws(() =>
    parsePauseExecutionRtcCommand(' '.repeat(PAUSE_EXECUTION_RTC_IPC_BYTES + 1)),
  )
})

test('execution child reply boundary schema refuses extra fields, secret tokens, and invalid outcomes', () => {
  const { native } = observations()
  assert.equal(PauseExecutionRtcReply.safeParse(native).success, true)

  // Extra fields leak check
  for (const extra of ['token', 'key', 'sdp', 'secret', 'password']) {
    assert.equal(
      PauseExecutionRtcReply.safeParse({ ...native, [extra]: 'private' })
        .success,
      false,
    )
  }

  // Non-boolean commandsEnabled check (must be literal true for execution actor)
  assert.equal(
    PauseExecutionRtcReply.safeParse({
      ...native,
      diagnostics: { ...native.diagnostics, commandsEnabled: false },
    }).success,
    false,
  )
})

test('execution progress tracker advances through lifecycle and preserves first failure', () => {
  const progress = createPauseExecutionRtcProgress()
  progress.advance('moonraker-starting')
  progress.advance('driver-prepared')
  progress.advance('relay-created')
  progress.fail('relay-open-failed', 'scope-mismatch')

  const snapshot = progress.snapshot()
  assert.equal(snapshot.firstFailure?.source, 'relay-open-failed')
  assert.equal(snapshot.firstFailure?.verifierRejection, 'scope-mismatch')

  // Subsequent events cannot overwrite first failure
  progress.fail('client-terminal')
  progress.advance('command-settled')
  assert.deepEqual(progress.snapshot().firstFailure, snapshot.firstFailure)
})

// Native acceptance is supplied through runSignallingHttpsAcceptance.extension.
// This factory check is source coverage, not an authenticated runtime gate.
test('execution fixture exposes the maintained provisioning extension contract', () => {
  const extension = createPauseExecutionRtcFixtureExtension({ testReplay: true })
  assert.equal(typeof extension.identityHandles, 'function')
  assert.equal(typeof extension.afterProvisioned, 'function')
})
