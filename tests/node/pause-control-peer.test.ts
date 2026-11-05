import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import {
  PauseBrowserPeer,
  pauseBrowserCertificate,
} from '../../apps/farm/app/utils/webrtc/pause-control-peer.ts'
import { captureEffectiveRtcDescriptions } from '../../packages/connector/src/webrtc/rtc-descriptions.ts'
import { checkPauseEffectiveDescriptions } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import type { ControlSessionBinding } from '../../packages/farm-protocol/src/control-session-binding.ts'

const pin = 'AA:'.repeat(31) + 'AA'
const sdp = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${pin}\r\n`
const expected = () => ({
  transportId: randomUUID(),
  farmId: randomUUID(),
  agentId: randomUUID(),
  assignmentId: randomUUID(),
  accountId: 'operator-fixture',
  keyId: randomUUID(),
  origin: 'https://farm.example',
  audience: 'pause-fixture',
})
async function privateKey(extractable = false) {
  return (
    await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      extractable,
      ['sign', 'verify'],
    )
  ).privateKey
}
class FakePeer {
  static instances: FakePeer[] = []
  static failClose = false
  closeCalls = 0
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: { type: string; sdp: string } | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((value: { track: { stop(): void } }) => void) | null = null
  ondatachannel: ((value: { channel: RTCDataChannel }) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  constructor() {
    FakePeer.instances.push(this)
  }
  async setRemoteDescription(value: { type: string; sdp: string }) {
    this.remoteDescription = { ...value }
  }
  async createAnswer() {
    return { type: 'answer', sdp }
  }
  async setLocalDescription(value: { type: string; sdp: string }) {
    this.localDescription = { ...value }
  }
  close() {
    this.closeCalls++
    if (FakePeer.failClose) throw Error('synthetic close failure')
  }
}
function installFake() {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'RTCPeerConnection',
  )
  FakePeer.instances = []
  FakePeer.failClose = false
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    writable: true,
    value: FakePeer,
  })
  return () => {
    if (original)
      Object.defineProperty(globalThis, 'RTCPeerConnection', original)
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
  }
}
test(
  'invalid key and incomplete browser context allocate no peer',
  { timeout: 5000 },
  async () => {
    const restore = installFake(),
      key = await privateKey(true)
    try {
      assert.throws(
        () =>
          new PauseBrowserPeer({
            privateKey: key,
            expected: expected(),
            expectedBinding: new Promise(() => {}),
          }),
        /Nonextractable/,
      )
      const valid = await privateKey(),
        scope = expected()
      Reflect.deleteProperty(scope, 'accountId')
      assert.throws(
        () =>
          new PauseBrowserPeer({
            privateKey: valid,
            expected: scope,
            expectedBinding: new Promise(() => {}),
          }),
        /incomplete/,
      )
      assert.equal(FakePeer.instances.length, 0)
    } finally {
      restore()
    }
  },
)
test(
  'one-shot browser answer returns exact transmitted bytes and closes independently after disposal failure',
  { timeout: 5000 },
  async () => {
    const restore = installFake(),
      key = await privateKey()
    let terminal = 0
    const peer = new PauseBrowserPeer({
      privateKey: key,
      expected: expected(),
      expectedBinding: new Promise(() => {}),
      onTerminal: () => {
        terminal++
      },
    })
    try {
      assert.equal(await peer.answer(sdp), sdp)
      FakePeer.failClose = true
      await assert.rejects(peer.answer(sdp), /unavailable/)
      await peer.closed
      assert.equal(terminal, 1)
      assert.equal(FakePeer.instances[0]?.closeCalls, 1)
      assert.equal(peer.diagnostics().cleanupFailures, 1)
      assert.equal(peer.diagnostics().certificateMatched, false)
      assert.equal(peer.diagnostics().commandsEnabled, false)
    } finally {
      peer.close()
      await peer.closed
      restore()
    }
  },
)
test(
  'constructor deadline cannot be extended and closes before late expected binding resolves',
  { timeout: 5000 },
  async (context) => {
    const restore = installFake(),
      key = await privateKey()
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let terminal = 0
    const peer = new PauseBrowserPeer({
      privateKey: key,
      expected: expected(),
      expectedBinding: new Promise(() => {}),
      authDeadline: performance.now() + 60000,
      lifetimeDeadline: performance.now() + 60000,
      onTerminal: () => {
        terminal++
      },
    })
    try {
      context.mock.timers.tick(8000)
      await peer.closed
      assert.equal(terminal, 1)
      assert.equal(peer.diagnostics().closeCount, 1)
      assert.equal(peer.diagnostics().sentProofs, 0)
    } finally {
      peer.close()
      await peer.closed
      context.mock.timers.reset()
      restore()
    }
  },
)
test('actual certificate selection rejects ambiguous connected transports and fingerprint mismatch', () => {
  const reports = new Map<string, Record<string, unknown>>([
    [
      'transport',
      {
        id: 'transport',
        type: 'transport',
        dtlsState: 'connected',
        remoteCertificateId: 'certificate',
      },
    ],
    [
      'certificate',
      {
        id: 'certificate',
        type: 'certificate',
        fingerprintAlgorithm: 'sha-256',
        fingerprint: pin,
      },
    ],
  ])
  const stats = reports as unknown as RTCStatsReport
  assert.equal(pauseBrowserCertificate(stats, pin), true)
  assert.equal(pauseBrowserCertificate(stats, 'BB:'.repeat(31) + 'BB'), false)
  reports.set('other', {
    id: 'other',
    type: 'transport',
    dtlsState: 'connected',
    remoteCertificateId: 'certificate',
  })
  assert.equal(pauseBrowserCertificate(stats, pin), false)
})
test('effective getter serialization is independently pinned without replacing exact signed wire bytes', () => {
  const captured = captureEffectiveRtcDescriptions(
    { type: 'answer', sdp },
    { type: 'offer', sdp },
  )
  const binding = {
    browser_dtls: pin,
    connector_dtls: pin,
  } as ControlSessionBinding
  assert.doesNotThrow(() =>
    checkPauseEffectiveDescriptions(binding, 'browser', captured, captured),
  )
  const replaced = captureEffectiveRtcDescriptions(
    { type: 'answer', sdp: sdp + 'a=extmap-allow-mixed\r\n' },
    { type: 'offer', sdp },
  )
  assert.throws(
    () =>
      checkPauseEffectiveDescriptions(binding, 'browser', captured, replaced),
    /changed/,
  )
})
