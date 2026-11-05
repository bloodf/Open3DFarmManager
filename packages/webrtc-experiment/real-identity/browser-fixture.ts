import { ReadonlyBrowserPeer } from './browser-peer.ts'
import { validateBrowserDevicePublicKey } from '../../farm-protocol/src/browser-device-proof.ts'
const key = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
)
let peer: ReadonlyBrowserPeer | undefined
let resolveBinding: (input: unknown) => void = () => {}
export async function identity() {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey)
  return validateBrowserDevicePublicKey({ kty, crv, x, y })
}
export function create(agent: string) {
  peer?.close()
  closeAttacker()
  const admittedBinding = new Promise<unknown>((resolve) => {
    resolveBinding = resolve
  })
  peer = new ReadonlyBrowserPeer({
    privateKey: key.privateKey,
    expectedAgentId: agent,
    admittedBinding,
  })
}
export async function answer(offer: string) {
  if (!peer) throw Error('No peer')
  return peer.answer(offer)
}
export function admit(binding: unknown) {
  resolveBinding(binding)
}
export function snapshot() {
  return (
    peer?.snapshot() ??
    (attacker
      ? {
          state: attackerClosed ? 'readonly' : 'pending',
          accepted: [],
          sentProofs: attackerSent,
          receivedProofs: attackerReceived,
        }
      : undefined)
  )
}
export function status() {
  return peer?.sendFixtureStatus() ?? false
}
export function close() {
  peer?.close()
  closeAttacker()
}

// Deliberately malicious browser, isolated from the authenticated adapter API.
// Exercises real inbound RTC frames; it grants no trust or application authority.
import {
  BrowserRtcProof,
  signRtcSessionProof,
  encodeRtcProof,
} from '../../farm-protocol/src/rtc-session-binding.ts'
let attacker: RTCPeerConnection | undefined
let attackerClosed = false,
  attackerSent = 0,
  attackerReceived = 0
let attackerTimer: ReturnType<typeof setTimeout> | undefined
function closeAttacker() {
  if (!attacker || attackerClosed) return
  attackerClosed = true
  clearTimeout(attackerTimer)
  attacker.close()
}
export async function replayWire(binding: unknown) {
  return encodeRtcProof(
    BrowserRtcProof.parse({
      v: 1,
      role: 'browser',
      binding,
      signature: await signRtcSessionProof(binding, 'browser', key.privateKey),
    }),
  )
}
export async function attackAnswer(
  offer: string,
  mode: 'replay' | 'preauth-status',
  wire: string,
) {
  peer?.close()
  peer = undefined
  closeAttacker()
  attacker = new RTCPeerConnection({ iceServers: [] })
  const current = attacker
  attackerClosed = false
  attackerSent = 0
  attackerReceived = 0
  attackerTimer = setTimeout(closeAttacker, 8000)
  let sent = false
  current.ondatachannel = ({ channel }) => {
    const send = () => {
      if (sent || attackerClosed) return
      if (mode === 'replay' && channel.label === 'readonly-proof-v1') {
        if (wire.length > 8192) throw Error('Attack fixture frame bound')
        sent = true
        channel.send(wire)
        attackerSent++
      }
      if (
        mode === 'preauth-status' &&
        channel.label === 'readonly-fixture-status-v1'
      ) {
        sent = true
        channel.send('{"kind":"readonly-status","value":"fixture-idle"}')
      }
    }
    channel.onopen = send
    channel.onmessage = () => {
      attackerReceived = Math.min(16, attackerReceived + 1)
    }
    channel.onclose = closeAttacker
    channel.onerror = closeAttacker
    if (channel.readyState === 'open') send()
  }
  await current.setRemoteDescription({ type: 'offer', sdp: offer })
  await current.setLocalDescription(await current.createAnswer())
  await new Promise<void>((resolve) => {
    if (current.iceGatheringState === 'complete') {
      resolve()
      return
    }
    current.onicegatheringstatechange = () => {
      if (current.iceGatheringState === 'complete') resolve()
    }
  })
  const answer = current.localDescription
  if (!answer) throw Error('No attacker answer')
  return answer.sdp
}
