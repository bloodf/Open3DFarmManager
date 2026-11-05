import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  createPauseAuthenticatedRtcFixtureExtension,
  verifyPauseRtcAcceptance,
} from '../helpers/pause-authenticated-rtc.ts'
import {
  parsePauseRtcCommand,
  PauseRtcReply,
  PAUSE_RTC_IPC_BYTES,
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
