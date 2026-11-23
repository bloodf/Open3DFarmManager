import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  FARM_STATUS_BACKPRESSURE_TIMEOUT_MS,
  FARM_STATUS_PENDING_BYTES,
  FarmStatusSender,
  type CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import {
  immutableAdmission,
  type VerifiedRtcAdmission,
} from '../../packages/connector/src/webrtc/readonly-session.ts'

test('a permanently buffered status channel stops sending and closes on timeout', async (t) => {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const browserKey = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const agentId = randomUUID()
  const farmId = randomUUID()
  const refs = [
    { assignmentId: randomUUID(), agentId, printerKey: 'printer-a' },
  ]
  const assignment = await assignmentSetDigest({ farmId, agentId }, refs)
  const now = Date.now()
  const admission: VerifiedRtcAdmission = immutableAdmission(
    {
      v: 2,
      purpose: 'read-only-rtc',
      transport_id: randomUUID(),
      farm_id: farmId,
      agent_id: agentId,
      account_id: 'test-account',
      key_id: randomUUID(),
      browser_public_key: browserKey.publicKey,
      browser_thumbprint: browserKey.thumbprint,
      connector_public_key_spki: identity.publicKeySpki,
      connector_fingerprint: identity.fingerprint,
      credential_jti: randomUUID(),
      origin: 'https://farm.example',
      audience: 'farm-test',
      browser_nonce: randomBytes(32).toString('base64url'),
      connector_nonce: randomBytes(32).toString('base64url'),
      issued_at: now - 1,
      expires_at: now + 20_000,
      commands_enabled: false,
      offer_sha256: randomBytes(32).toString('base64url'),
      answer_sha256: randomBytes(32).toString('base64url'),
      browser_dtls: Array(32).fill('AA').join(':'),
      connector_dtls: Array(32).fill('BB').join(':'),
      assignment_count: assignment.count,
      assignment_digest: assignment.digest,
    },
    performance.now() + 15_000,
  )
  let onAdmission: ((value: VerifiedRtcAdmission) => void) | undefined
  let onComplete: ((value: CompleteFarmSnapshot) => void) | undefined
  let sent = 0
  let closed = 0
  let closeReason = ''
  const sender = new FarmStatusSender({
    assignmentRefs: refs,
    signal: new AbortController().signal,
    client: {
      start: async () => {},
      subscribeVerifiedAdmission(listener) {
        onAdmission = listener
        return () => {}
      },
      subscribeTerminal() {
        return () => {}
      },
      bufferedAmount: () => FARM_STATUS_PENDING_BYTES + 1,
      sendStatus() {
        sent++
        return true
      },
      close(reason = '') {
        closed++
        closeReason = reason
      },
    },
    openSnapshots(input) {
      onComplete = input.onComplete
      return { close() {} }
    },
  })
  try {
    onAdmission?.(admission)
    for (let turn = 0; !onComplete && !closed && turn < 100; turn++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(onComplete, 'snapshot provider should open after admission')
    const complete = () =>
      onComplete!({
        assignmentRefs: refs,
        complete: true,
        printers: [
          {
            printerKey: 'printer-a',
            state: 'printing',
            progress: 0.5,
            observedAt: Date.now(),
          },
        ],
        capturedAtMonoMs: performance.now(),
        validUntilMonoMs: performance.now() + 10_000,
      })
    complete()
    complete()
    assert.equal(sent, 0, 'buffered channel must not queue snapshots')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(
      closed,
      0,
      `peer must remain open before the congestion grace deadline (${closeReason})`,
    )
    await new Promise((resolve) =>
      setTimeout(resolve, FARM_STATUS_BACKPRESSURE_TIMEOUT_MS),
    )
    assert.equal(closed, 1, 'sender must close after sustained congestion')
  } finally {
    sender.close()
  }
})
