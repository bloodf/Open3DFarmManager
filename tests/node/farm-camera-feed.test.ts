// Original work, MIT licensed. Synthetic keys and fake RTC objects only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { createAuthenticatedFarmStatusFeed } from '../../apps/farm/app/utils/webrtc/farm-status-feed.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { RtcSessionBinding } from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import {
  cameraStatementFromBinding,
  verifyExpectedCameraPurposeProof,
} from '../../packages/farm-protocol/src/camera-purpose-statement.ts'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'

type Options = Parameters<typeof createAuthenticatedFarmStatusFeed>[0]
type ClientInput = Parameters<NonNullable<Options['createClient']>>[0]

// Node has no MediaStream; the feed only forwards the object it receives.
class FakeMediaStream {
  tracks: unknown[]
  constructor(tracks: unknown[]) {
    this.tracks = tracks
  }
}
Object.assign(globalThis, { MediaStream: FakeMediaStream })

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(check(), 'condition not reached')
}

async function fixture(withCamera = true) {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    keyPair.publicKey,
  )
  const key = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const scope = {
    accountId: 'account_test',
    farmId: randomUUID(),
    viewEpoch: 1,
  }
  const agentId = randomUUID(),
    keyId = randomUUID(),
    assignmentId = randomUUID()
  const refs = [{ assignmentId, agentId, printerKey: 'printer-a' }]
  const connector = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const set = await assignmentSetDigest({ farmId: scope.farmId, agentId }, refs)
  const nonce = () => randomBytes(32).toString('base64url'),
    now = Date.now()
  const binding = RtcSessionBinding.parse({
    v: 2,
    assignment_count: set.count,
    assignment_digest: set.digest,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: scope.farmId,
    agent_id: agentId,
    account_id: scope.accountId,
    key_id: keyId,
    browser_public_key: key.publicKey,
    browser_thumbprint: key.thumbprint,
    connector_public_key_spki: connector.publicKeySpki,
    connector_fingerprint: connector.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'farm-test',
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: now - 10,
    expires_at: now + 10000,
    commands_enabled: false,
    offer_sha256: nonce(),
    answer_sha256: nonce(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  })
  const events: { assignmentId: string; stream: unknown }[] = []
  let client: ClientInput | undefined
  const feed = createAuthenticatedFarmStatusFeed({
    resolveKey: async (request) => ({
      scope: { ...request.scope },
      keyId,
      origin: binding.origin,
      audience: binding.audience,
      localKey: {
        thumbprint: key.thumbprint,
        publicKey: key.publicKey,
        keyPair,
      },
    }),
    createClient(input) {
      client = input
      return { start: async () => {}, close() {} }
    },
    ...(withCamera ? { onCamera: (event) => events.push(event) } : {}),
  })
  const handle = feed.open({
    scope,
    agentId,
    assignmentRefs: refs,
    browserKeyId: keyId,
    signal: new AbortController().signal,
    onHealth() {},
    onSnapshot() {},
  })
  await until(() => client !== undefined)
  const violations: string[] = []
  const sent: string[] = []
  const track = {
    kind: 'video',
    stopped: false,
    onended: null as unknown,
    stop() {
      this.stopped = true
    },
  }
  const channel = {
    readyState: 'open',
    onmessage: null as null | ((event: { data: unknown }) => void),
    send: (wire: string) => sent.push(wire),
    close() {},
  }
  const hooks = client!.cameraMedia?.((reason) => violations.push(reason))
  const offer = (printerId: string) =>
    connector.signCameraPurposeProof({
      statement: cameraStatementFromBinding(binding, {
        camera_id: 'cam-1',
        printer_id: printerId,
        video_mid: 'camera',
        lease_ref: nonce(),
      }),
      expectedAgentId: agentId,
    })
  return {
    hooks,
    binding,
    assignmentId,
    events,
    violations,
    sent,
    track,
    handle,
    offer,
    start() {
      hooks!.onTrack({
        track: track as never,
        receiver: {} as never,
        mid: 'camera',
      })
      hooks!.onChannel(channel as never)
      hooks!.activate({ binding, lifetimeDeadline: performance.now() + 9000 })
    },
    deliver: (wire: string) => channel.onmessage?.({ data: wire }),
  }
}

test('an assigned camera offer is countersigned, published and revoked with the feed', async () => {
  const f = await fixture()
  f.start()
  f.deliver(f.offer(f.assignmentId))
  await until(() => f.events.length === 1)
  assert.equal(f.events[0]!.assignmentId, f.assignmentId)
  assert.ok(f.events[0]!.stream instanceof FakeMediaStream)
  assert.equal(f.sent.length, 1)
  const answered = JSON.parse(f.sent[0]!) as { binding: unknown }
  assert.ok(
    await verifyExpectedCameraPurposeProof({
      expectedStatement: answered.binding,
      expectedRole: 'browser',
      expectedPublicKey: f.binding.browser_public_key,
      wire: f.sent[0],
    }),
  )
  f.handle.close()
  // Closing the feed closes the client; the peer's close stops camera media.
  f.hooks!.stop()
  assert.deepEqual(f.events.at(-1), {
    assignmentId: f.assignmentId,
    stream: null,
  })
  assert.equal(f.track.stopped, true)
  assert.deepEqual(f.violations, [])
})

test('offers for assignments outside the server refs never reach the view', async () => {
  const f = await fixture()
  f.start()
  f.deliver(f.offer(randomUUID()))
  await until(() => f.violations.length === 1)
  assert.deepEqual(f.violations, ['camera-unauthorized'])
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.sent, [])
})

test('without an onCamera consumer no camera hooks are created', async () => {
  const f = await fixture(false)
  assert.equal(f.hooks, undefined)
})
