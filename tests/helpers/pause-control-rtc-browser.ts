import { PauseBrowserPeer } from '../../apps/farm/app/utils/webrtc/pause-control-peer.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PauseBrowserExpectedContext,
  type PausePhaseMessage,
  type PauseProofsReady,
  type PausePhaseFrame,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'

// Isolated synthetic-signalling fixture. No registry, current SQL or command authority.
let key: CryptoKeyPair | undefined
let peer: PauseBrowserPeer | undefined
let resolveBinding: ((value: unknown) => void) | undefined
let ready: PauseProofsReady | undefined
let phases: Readonly<PausePhaseFrame>[] = []
let reason: string | undefined
let terminals = 0
let settled = false

export async function initialize() {
  if (key) throw Error('Fixture identity already initialized')
  key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey)
  return validateBrowserDevicePublicKey({ kty, crv, x, y })
}
export async function create(expected: unknown, wrongProof: boolean) {
  if (!key || peer) throw Error('Fixture peer lifecycle')
  const context = PauseBrowserExpectedContext.parse(expected)
  const signingKey = wrongProof
    ? (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])).privateKey
    : key.privateKey
  const expectedBinding = new Promise<unknown>((resolve) => { resolveBinding = resolve })
  peer = new PauseBrowserPeer({
    privateKey: signingKey, expected: context, expectedBinding,
    onProofsReady(value) { ready = value },
    onPhase(value) {
      if (phases.length >= 2) throw Error('Fixture phase capacity')
      phases.push(value)
    },
    onTerminal(value) { terminals++; reason = value },
  })
  void peer.closed.then(() => { settled = true })
}
export async function answer(sdp: string) {
  if (!peer) throw Error('Missing peer')
  return peer.answer(sdp)
}
export function admit(binding: unknown) {
  if (!resolveBinding) throw Error('Missing synthetic binding resolver')
  const resolve = resolveBinding
  resolveBinding = undefined
  resolve(binding)
}
export function send(message: PausePhaseMessage) {
  if (!peer) throw Error('Missing peer')
  return peer.sendPhase(message)
}
export function snapshot() {
  if (!peer) throw Error('Missing peer')
  return { diagnostics: peer.diagnostics(), ready, phases, terminals, settled, reason }
}
export async function close() {
  if (peer) { peer.close('fixture-close'); await peer.closed }
  return snapshot()
}
