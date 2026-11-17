import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  READONLY_BACKPRESSURE_TIMEOUT_MS,
  ReadonlyStatusQueue,
  type StatusChannelPort,
} from '../../packages/connector/src/webrtc/readonly-peer.ts'
import {
  FarmStatusSender,
  type CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import {
  immutableAdmission,
  type VerifiedRtcAdmission,
} from '../../packages/connector/src/webrtc/readonly-session.ts'

/** Fake native channel. A congested channel refuses writes and queues the
 * bytes natively, exactly like node-datachannel under SCTP backpressure. */
class FakeChannel implements StatusChannelPort {
  open = true
  congested = true
  queued = 0
  delivered: string[] = []
  #low: (() => void) | undefined
  onBufferedAmountLow(callback: () => void) {
    this.#low = callback
  }
  isOpen() {
    return this.open
  }
  bufferedAmount() {
    return this.queued
  }
  sendMessage(wire: string) {
    if (this.congested) {
      this.queued += wire.length
      return false
    }
    this.delivered.push(wire)
    return true
  }
  /** The native queue drains and the low-water callback fires. */
  drain() {
    this.congested = false
    this.queued = 0
    this.#low?.()
  }
}

test('a refused native write keeps the read-only status queue open and coalesces frames until it drains', () => {
  const channel = new FakeChannel()
  let terminal: string | undefined
  const queue = new ReadonlyStatusQueue<string>({
    channel,
    // The session adapter writes the wire natively.
    write: (frame) => {
      queue.sendWire(frame)
      return true
    },
    onTerminal: (reason) => {
      terminal = reason
    },
  })
  try {
    // A refused native write is backpressure, not a rejected frame: the peer
    // adapter must not turn it into a send failure.
    assert.equal(queue.sendWire('probe'), 'coalesced')
    assert.equal(terminal, undefined, 'a refused write must not close the peer')
    assert.equal(queue.offer('frame-1'), false)
    assert.equal(terminal, undefined, 'a refused write must not close the peer')
    assert.equal(queue.pending(), true)
    // Newer frames supersede the held one: only the newest survives.
    assert.equal(queue.offer('frame-2'), false)
    assert.equal(queue.offer('frame-3'), false)
    assert.deepEqual(channel.delivered, [])
    assert.equal(terminal, undefined)
    // The native queue drains: the coalesced frame is delivered.
    channel.drain()
    assert.deepEqual(channel.delivered, ['frame-3'])
    assert.equal(queue.pending(), false)
    // Delivery resumes on the same session.
    assert.equal(queue.offer('frame-4'), true)
    assert.deepEqual(channel.delivered, ['frame-3', 'frame-4'])
    assert.equal(terminal, undefined)
  } finally {
    queue.close()
  }
})

test('a status queue that never drains closes within the #173 timeout', async () => {
  const channel = new FakeChannel()
  let terminal: string | undefined
  const queue = new ReadonlyStatusQueue<string>({
    channel,
    write: (frame) => {
      queue.sendWire(frame)
      return true
    },
    onTerminal: (reason) => {
      terminal = reason
    },
  })
  try {
    const started = performance.now()
    assert.equal(queue.offer('frame-1'), false)
    while (
      !terminal &&
      performance.now() - started < READONLY_BACKPRESSURE_TIMEOUT_MS + 2000
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(terminal, 'status-backpressure')
    assert.ok(
      performance.now() - started <= READONLY_BACKPRESSURE_TIMEOUT_MS + 1000,
      'congestion must close the peer within the #173 timeout',
    )
  } finally {
    queue.close()
  }
})

test('a closed native channel still closes the read-only status queue', () => {
  const channel = new FakeChannel()
  channel.open = false
  let terminal: string | undefined
  const queue = new ReadonlyStatusQueue<string>({
    channel,
    write: () => true,
    onTerminal: (reason) => {
      terminal = reason
    },
  })
  try {
    assert.equal(queue.sendWire('frame'), 'rejected')
    assert.equal(terminal, 'status-channel-closed')
    assert.equal(queue.offer('frame'), false)
  } finally {
    queue.close()
  }
})

async function admission(): Promise<{
  admission: VerifiedRtcAdmission
  refs: { assignmentId: string; agentId: string; printerKey: string }[]
}> {
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
  return {
    refs,
    admission: immutableAdmission(
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
    ),
  }
}

test('a congested status peer coalesces snapshots instead of closing the session', async () => {
  const fixture = await admission()
  let onAdmission: ((value: VerifiedRtcAdmission) => void) | undefined
  let onComplete: ((value: CompleteFarmSnapshot) => void) | undefined
  let congested = true
  const sent: unknown[] = []
  let closed = 0
  let closeReason: string | undefined
  const sender = new FarmStatusSender({
    assignmentRefs: fixture.refs,
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
      bufferedAmount: () => 0,
      sendStatus(message) {
        // The native channel refused the frame: the peer coalesces it.
        if (congested) return false
        sent.push(message)
        return true
      },
      close(reason) {
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
    onAdmission?.(fixture.admission)
    for (let turn = 0; !onComplete && !closed && turn < 100; turn++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(onComplete, 'snapshot provider should open after admission')
    const complete = () =>
      onComplete!({
        assignmentRefs: fixture.refs,
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
    // Congested attempts never close the session and never spend the frame
    // budget: the peer keeps the newest snapshot for the next drain.
    for (let attempt = 0; attempt < 1100; attempt++) complete()
    assert.equal(
      closed,
      0,
      `a congested peer must not close the session (${closeReason})`,
    )
    assert.equal(sent.length, 0)
    // The channel drains: delivery resumes on the same session.
    congested = false
    complete()
    assert.equal(sent.length, 1)
    assert.equal(closed, 0)
  } finally {
    sender.close()
  }
})
