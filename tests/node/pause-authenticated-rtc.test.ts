import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  createPauseAuthenticatedRtcFixtureExtension,
  verifyPauseRtcAcceptance,
  pauseBrowserFailureProjection,
} from '../helpers/pause-authenticated-rtc.ts'
import {
  parsePauseRtcCommand,
  PauseRtcReply,
  PAUSE_RTC_IPC_BYTES,
  PauseRtcProgress,
  createPauseRtcProgress,
} from '../helpers/pause-rtc-connector-child.ts'
import type { SignallingFixtureExtension } from '../helpers/signalling-https-fixture-contract.ts'

function observations() {
  const diagnostics = {
    certificateMatched: true,
    sentProofs: 1,
    receivedProofs: 1,
    terminal: false,
    commandsEnabled: false,
  }
  return {
    native: {
      kind: 'observation',
      inboxReady: true,
      proofsReady: true,
      capabilityAccepted: true,
      terminal: false,
      failed: false,
      diagnostics: { ...diagnostics },
      progress: {
        stage: 'verifier-accepted',
        clientPhase: 'active',
        terminalReason: null,
        firstFailure: null,
      },
    },
    browser: {
      terminal: false,
      failed: false,
      proofsReady: true,
      issued: true,
      receipt: {
        transportId: randomUUID(),
        challengeId: randomUUID(),
        capabilityHash: 'a'.repeat(64),
      },
      diagnostics: { ...diagnostics },
    },
  }
}

test('pause extension factory is inert and implements the frozen parent seam', () => {
  const before = process.getActiveResourcesInfo().sort()
  const extension: SignallingFixtureExtension =
    createPauseAuthenticatedRtcFixtureExtension()
  assert.deepEqual(Object.keys(extension).sort(), [
    'afterProvisioned',
    'identityHandles',
  ])
  assert.equal(Object.isFrozen(extension), true)
  assert.deepEqual(process.getActiveResourcesInfo().sort(), before)
})

test('aborted identity callback and unprovisioned callback fail before any resource access', async () => {
  const extension = createPauseAuthenticatedRtcFixtureExtension()
  const signal = AbortSignal.abort(Error('fixture cancelled'))
  let accesses = 0
  const input = new Proxy(
    { signal },
    {
      get(target, property) {
        if (property === 'signal') return target.signal
        accesses++
        throw Error('Resource access forbidden')
      },
    },
  )
  await assert.rejects(
    Reflect.apply(extension.identityHandles, extension, [input]),
    /fixture cancelled/,
  )
  await assert.rejects(
    Reflect.apply(extension.afterProvisioned, extension, [{}]),
    /scope mismatch/,
  )
  assert.equal(accesses, 0)
})

test('acceptance requires both admissions, actual HTTP issuance receipt and native verification', () => {
  const { native, browser } = observations()
  assert.doesNotThrow(() => verifyPauseRtcAcceptance(native, browser))
  for (const patch of [
    { inboxReady: false },
    { proofsReady: false },
    { capabilityAccepted: false },
    { terminal: true },
    { failed: true },
  ])
    assert.throws(() =>
      verifyPauseRtcAcceptance({ ...native, ...patch }, browser),
    )
  for (const patch of [
    { proofsReady: false },
    { issued: false },
    { receipt: undefined },
    { terminal: true },
    { failed: true },
  ])
    assert.throws(() =>
      verifyPauseRtcAcceptance(native, { ...browser, ...patch }),
    )
})

test('both peers must match certificates and exchange exactly one proof with commands disabled', () => {
  const { native, browser } = observations()
  for (const patch of [
    { certificateMatched: false },
    { sentProofs: 0 },
    { receivedProofs: 0 },
    { sentProofs: 2 },
    { terminal: true },
    { commandsEnabled: true },
  ]) {
    assert.throws(() =>
      verifyPauseRtcAcceptance(
        { ...native, diagnostics: { ...native.diagnostics, ...patch } },
        browser,
      ),
    )
    assert.throws(() =>
      verifyPauseRtcAcceptance(native, {
        ...browser,
        diagnostics: { ...browser.diagnostics, ...patch },
      }),
    )
  }
  assert.throws(() =>
    verifyPauseRtcAcceptance(native, {
      ...browser,
      receipt: { ...browser.receipt, capabilityHash: 'invalid' },
    }),
  )
})

test('private child protocol excludes manufactured admissions, raw WSS, SDP and command controls', () => {
  assert.deepEqual(parsePauseRtcCommand('{"kind":"observe"}'), {
    kind: 'observe',
  })
  for (const command of [
    { kind: 'admit', binding: {} },
    { kind: 'proof', signature: 'fabricated' },
    { kind: 'capability', wire: 'fabricated' },
    { kind: 'answer', sdp: 'manual' },
    { kind: 'pause' },
    { kind: 'observe', token: 'private' },
  ])
    assert.throws(() => parsePauseRtcCommand(JSON.stringify(command)))
  assert.throws(() =>
    parsePauseRtcCommand('{"kind":"observe","kind":"identity"}'),
  )
  assert.throws(() => parsePauseRtcCommand(' '.repeat(PAUSE_RTC_IPC_BYTES + 1)))
  const { native } = observations()
  assert.equal(
    PauseRtcReply.safeParse({ ...native, token: 'private' }).success,
    false,
  )
})

test('finite progress retains the first failure and its stage through cleanup', () => {
  const progress = createPauseRtcProgress()
  progress.advance('verifier-starting')
  progress.phase('active')
  progress.fail('verifier-denied', 'scope-mismatch')
  const first = progress.snapshot()
  assert.deepEqual(first.firstFailure, {
    source: 'verifier-denied',
    stage: 'verifier-starting',
    clientPhase: 'active',
    terminalReason: null,
    verifierRejection: 'scope-mismatch',
  })
  progress.terminal('fixture-closed')
  progress.fail('client-start')
  progress.advance('verifier-accepted')
  assert.deepEqual(progress.snapshot(), {
    stage: 'verifier-starting',
    clientPhase: 'active',
    terminalReason: 'fixture-closed',
    firstFailure: first.firstFailure,
  })
})

test('progress schema refuses extra fields and arbitrary failure, phase, reason or rejection strings', () => {
  const progress = createPauseRtcProgress()
  progress.advance('nonce-sent')
  progress.phase('active')
  progress.terminal('certificate-or-binding')
  progress.fail('client-start')
  const value = progress.snapshot()
  assert.equal(PauseRtcProgress.safeParse(value).success, true)
  for (const key of [
    'token',
    'key',
    'sdp',
    'proof',
    'nonce',
    'error',
    'stack',
  ]) {
    assert.equal(
      PauseRtcProgress.safeParse({ ...value, [key]: 'private' }).success,
      false,
    )
    assert.equal(
      PauseRtcProgress.safeParse({
        ...value,
        firstFailure: { ...value.firstFailure, [key]: 'private' },
      }).success,
      false,
    )
  }
  for (const patch of [
    { stage: 'arbitrary' },
    { clientPhase: 'arbitrary' },
    { terminalReason: 'arbitrary' },
  ])
    assert.equal(
      PauseRtcProgress.safeParse({ ...value, ...patch }).success,
      false,
    )
  for (const patch of [
    { source: 'arbitrary' },
    { stage: 'arbitrary' },
    { clientPhase: 'arbitrary' },
    { terminalReason: 'arbitrary' },
    { verifierRejection: 'arbitrary' },
  ])
    assert.equal(
      PauseRtcProgress.safeParse({
        ...value,
        firstFailure: { ...value.firstFailure, ...patch },
      }).success,
      false,
    )
  const { native } = observations()
  assert.equal(
    PauseRtcReply.safeParse({ ...native, progress: value }).success,
    true,
  )
  assert.ok(
    Buffer.byteLength(JSON.stringify({ ...native, progress: value })) < 1024,
  )
})

test('untrusted client phase and terminal text are reduced to fixed other labels', () => {
  const progress = createPauseRtcProgress()
  progress.phase('secret-token-in-phase')
  progress.terminal('secret-token-in-terminal')
  progress.fail('client-start')
  progress.terminal('fixture-closed')
  const value = progress.snapshot()
  assert.equal(value.clientPhase, 'other')
  assert.equal(value.terminalReason, 'other')
  assert.equal(value.firstFailure?.terminalReason, 'other')
  assert.equal(JSON.stringify(value).includes('secret-token'), false)
})

test('diagnostic progress never supplies acceptance or erases a recorded failure', () => {
  const { native, browser } = observations()
  assert.throws(() =>
    verifyPauseRtcAcceptance({ ...native, capabilityAccepted: false }, browser),
  )
  const progress = createPauseRtcProgress()
  progress.advance('verifier-accepted')
  progress.fail('client-start')
  assert.throws(() =>
    verifyPauseRtcAcceptance(
      { ...native, progress: progress.snapshot() },
      browser,
    ),
  )
  assert.throws(() => verifyPauseRtcAcceptance({ ...native.progress }, browser))
})

test('browser failure projection excludes receipt identifiers and refuses secret extras', () => {
  const { browser } = observations()
  const projection = pauseBrowserFailureProjection(browser)
  assert.deepEqual(projection, {
    terminal: false,
    failed: false,
    proofsReady: true,
    issued: true,
    receiptPresent: true,
    diagnostics: browser.diagnostics,
  })
  const wire = JSON.stringify(projection)
  assert.equal(wire.includes(browser.receipt.transportId), false)
  assert.equal(wire.includes(browser.receipt.challengeId), false)
  assert.equal(wire.includes(browser.receipt.capabilityHash), false)
  for (const key of ['token', 'sdp', 'key', 'proof', 'nonce', 'error'])
    assert.throws(() =>
      pauseBrowserFailureProjection({ ...browser, [key]: 'private' }),
    )
  assert.throws(() =>
    pauseBrowserFailureProjection({
      ...browser,
      diagnostics: { ...browser.diagnostics, token: 'private' },
    }),
  )
})

test('unexpected client termination keeps the proof-ready stage and excludes unknown rejection details', () => {
  const progress = createPauseRtcProgress()
  progress.advance('proofs-ready')
  progress.phase('active')
  progress.terminal('socket-closed')
  progress.fail('client-terminal', { token: 'private-secret' })
  progress.fail('verifier-error')
  const snapshot = progress.snapshot()
  assert.deepEqual(snapshot.firstFailure, {
    source: 'client-terminal',
    stage: 'proofs-ready',
    clientPhase: 'active',
    terminalReason: 'socket-closed',
    verifierRejection: null,
  })
  assert.equal(JSON.stringify(snapshot).includes('private-secret'), false)
})

test('pre-issuance browser failure has no receipt and missing proof diagnostics cannot pass acceptance', () => {
  const { native, browser } = observations()
  const projection = pauseBrowserFailureProjection({
    ...browser,
    issued: false,
    receipt: undefined,
  })
  assert.equal(projection.receiptPresent, false)
  assert.equal(projection.issued, false)
  assert.throws(() =>
    verifyPauseRtcAcceptance(native, {
      ...browser,
      diagnostics: undefined,
    }),
  )
})
