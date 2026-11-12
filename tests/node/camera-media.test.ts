// Original work, MIT licensed. Synthetic keys, fake native track; no RTSP or printer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { RtcSessionBinding } from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import {
  decodeCameraPurposeProof,
  signCameraPurposeProof,
  verifyExpectedCameraPurposeProof,
} from '../../packages/farm-protocol/src/camera-purpose-statement.ts'
import {
  CAMERA_CHANNEL_LABEL,
  CAMERA_VIDEO_MID,
  ConnectorCameraMedia,
  type CameraNative,
} from '../../packages/connector/src/camera/camera-media.ts'
import type { CameraAccessUnit } from '../../packages/connector/src/camera/session.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await tick()
  assert.ok(check(), 'condition not reached')
}

class FakeTrack {
  open = true
  sent: Buffer[] = []
  setMediaHandler() {}
  onClosed() {}
  onError() {}
  isOpen() {
    return this.open
  }
  sendMessageBinary(data: Buffer) {
    this.sent.push(Buffer.from(data))
    return this.open
  }
  close() {
    this.open = false
  }
}
class FakeChannel {
  sent: string[] = []
  closed = false
  #handler: (raw: unknown) => void = () => {}
  #closed: () => void = () => {}
  onClosed(handler: () => void) {
    this.#closed = handler
  }
  remoteClose() {
    this.#closed()
  }
  onMessage(handler: (raw: unknown) => void) {
    this.#handler = handler
  }
  deliver(raw: unknown) {
    this.#handler(raw)
  }
  sendMessage(wire: string) {
    this.sent.push(wire)
    return !this.closed
  }
  close() {
    this.closed = true
  }
}
const native = {
  Video: class {
    mid: string
    constructor(mid: string) {
      this.mid = mid
    }
    addH264Codec() {}
    addSSRC() {}
  },
  RtpPacketizationConfig: class {
    timestamp = 0
  },
  H264RtpPacketizer: class {},
} as unknown as CameraNative

async function fixture(
  options: { assigned?: boolean; slots?: number; units?: number } = {},
) {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const browserKeys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browserKeys.publicKey,
  )
  const browser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const agentId = randomUUID(),
    farmId = randomUUID(),
    assignmentId = randomUUID()
  const digest = () => randomBytes(32).toString('base64url')
  const now = Date.now()
  const binding = RtcSessionBinding.parse({
    v: 2,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: farmId,
    agent_id: agentId,
    account_id: 'synthetic_account',
    key_id: randomUUID(),
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now - 1000,
    expires_at: now + 20000,
    commands_enabled: false,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
    assignment_count: 1,
    assignment_digest: digest(),
  })
  const track = new FakeTrack(),
    channel = new FakeChannel()
  const violations: string[] = [],
    opened: string[] = [],
    currents: (() => boolean)[] = []
  let slots = options.slots ?? 1,
    released = 0
  const media = new ConnectorCameraMedia({
    native,
    expectedAgentId: agentId,
    assignmentRefs: [
      {
        assignmentId: options.assigned === false ? randomUUID() : assignmentId,
        agentId,
        printerKey: 'printer one',
      },
    ],
    cameras: [
      {
        cameraId: 'cam-1',
        scope: { farmId, agentId, printerId: assignmentId },
        sourceHandle: 'rtsp-sim',
      },
    ],
    signProof: (statement) =>
      identity.signCameraPurposeProof({ statement, expectedAgentId: agentId }),
    async openSource(handle, _signal, _expiresAt, isCurrent) {
      opened.push(handle)
      currents.push(isCurrent)
      const count = options.units ?? 3
      return (async function* (): AsyncGenerator<CameraAccessUnit> {
        for (let i = 0; i < count; i++) {
          yield {
            data: new Uint8Array([0, 0, 0, 1, i ? 0x41 : 0x65, i]),
            keyframe: i === 0,
            timestampUs: i * 200000,
          }
          await tick()
        }
      })()
    },
    acquireSlot() {
      if (slots <= 0) return undefined
      slots--
      return () => {
        released++
        slots++
      }
    },
    onViolation: (reason) => violations.push(reason),
  })
  let channelLabel = ''
  media.prepare({
    addVideoTrack(description) {
      assert.equal((description as unknown as { mid: string }).mid, 'camera')
      return track as never
    },
    createDataChannel(label) {
      channelLabel = label
      return channel as never
    },
  })
  assert.equal(channelLabel, CAMERA_CHANNEL_LABEL)
  return {
    media,
    binding,
    track,
    channel,
    violations,
    opened,
    currents,
    browserKeys,
    released: () => released,
    activate() {
      media.activate({
        binding,
        lifetimeDeadline: performance.now() + 20000,
      })
    },
  }
}

async function countersign(f: Awaited<ReturnType<typeof fixture>>) {
  await until(() => f.channel.sent.length === 1)
  const offered = decodeCameraPurposeProof(f.channel.sent[0])
  assert.ok(
    await verifyExpectedCameraPurposeProof({
      expectedStatement: offered.binding,
      expectedRole: 'connector',
      expectedPublicKey: f.binding.connector_public_key_spki,
      wire: f.channel.sent[0],
    }),
  )
  return offered.binding
}

test('offers a bound statement and sends passthrough units only after the browser countersigns', async () => {
  const f = await fixture()
  f.activate()
  const statement = await countersign(f)
  assert.equal(statement.video_mid, CAMERA_VIDEO_MID)
  assert.equal(statement.camera_id, 'cam-1')
  assert.equal(statement.transport_id, f.binding.transport_id)
  assert.equal(statement.expires_at, f.binding.expires_at)
  assert.equal(f.opened.length, 0, 'no source before browser proof')
  assert.equal(f.track.sent.length, 0)
  f.channel.deliver(
    await signCameraPurposeProof(
      statement,
      'browser',
      f.browserKeys.privateKey,
    ),
  )
  await until(() => f.track.sent.length === 3)
  assert.deepEqual(f.opened, ['rtsp-sim'])
  assert.deepEqual(f.track.sent[0], Buffer.from([0, 0, 0, 1, 0x65, 0]))
  assert.deepEqual(f.violations, [])
  await until(() => f.released() === 1)
})

test('revocation stops synchronously and submits nothing afterwards', async () => {
  const f = await fixture({ units: 50 })
  f.activate()
  const statement = await countersign(f)
  f.channel.deliver(
    await signCameraPurposeProof(
      statement,
      'browser',
      f.browserKeys.privateKey,
    ),
  )
  await until(() => f.track.sent.length >= 2)
  assert.equal(f.currents[0]!(), true)
  f.media.stop()
  assert.equal(f.currents[0]!(), false)
  const count = f.track.sent.length
  assert.equal(f.track.open, false)
  assert.equal(f.channel.closed, true)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(f.track.sent.length, count)
  await until(() => f.released() === 1)
})

test('wrong browser key, early or repeated frames fail closed without a source', async () => {
  const f = await fixture()
  f.channel.deliver('{}')
  assert.deepEqual(f.violations, ['camera-frame'])
  assert.equal(f.track.open, false)

  const g = await fixture()
  g.activate()
  const statement = await countersign(g)
  const other = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )) as CryptoKeyPair
  g.channel.deliver(
    await signCameraPurposeProof(statement, 'browser', other.privateKey),
  )
  await until(() => g.violations.length === 1)
  assert.deepEqual(g.violations, ['camera-proof'])
  assert.deepEqual(g.opened, [])

  const h = await fixture()
  h.activate()
  const tampered = { ...(await countersign(h)), lease_ref: 'other-lease' }
  h.channel.deliver(
    await signCameraPurposeProof(tampered, 'browser', h.browserKeys.privateKey),
  )
  h.channel.deliver('again')
  await until(() => h.violations.length === 1)
  assert.deepEqual(h.opened, [])
})

test('unassigned cameras are never offered and an exhausted slot never opens a source', async () => {
  const f = await fixture({ assigned: false })
  f.activate()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(f.channel.sent, [])
  assert.deepEqual(f.violations, [])

  const g = await fixture({ slots: 0 })
  g.activate()
  const statement = await countersign(g)
  g.channel.deliver(
    await signCameraPurposeProof(
      statement,
      'browser',
      g.browserKeys.privateKey,
    ),
  )
  await until(() => g.track.open === false)
  assert.deepEqual(g.opened, [])
  assert.deepEqual(g.violations, [])
})

test('a browser that closes only the camera channel declines without a violation', async () => {
  const f = await fixture()
  f.activate()
  await countersign(f)
  f.channel.remoteClose()
  assert.equal(f.track.open, false)
  assert.deepEqual(f.violations, [])
  assert.deepEqual(f.opened, [])
})
