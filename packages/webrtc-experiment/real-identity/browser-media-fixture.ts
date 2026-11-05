import { ReadonlyBrowserPeer } from '../../../apps/farm/app/utils/webrtc/readonly-peer.ts'
import { DecodedVideoFixture } from './decoded-video-fixture.ts'
import { RtcSessionBinding } from '../../farm-protocol/src/rtc-session-binding.ts'
import { validateBrowserDevicePublicKey } from '../../farm-protocol/src/browser-device-proof.ts'
const key = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
)
let peer: ReadonlyBrowserPeer | undefined,
  video: DecodedVideoFixture | undefined
let resolveBinding: (value: unknown) => void = () => {},
  admittedTransport: string | undefined
export async function identity() {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey)
  return validateBrowserDevicePublicKey({ kty, crv, x, y })
}
export function create(agent: string) {
  peer?.close()
  admittedTransport = undefined
  const admittedBinding = new Promise<unknown>((resolve) => {
    resolveBinding = resolve
  })
  video = new DecodedVideoFixture({
    admit: ({ binding }) => {
      if (binding.transport_id !== admittedTransport)
        throw Error('Fixture video admission absent')
      return performance.now() + 5000
    },
    onTerminal: () => peer?.close('finite-video-terminal'),
  })
  peer = new ReadonlyBrowserPeer({
    privateKey: key.privateKey,
    expectedAgentId: agent,
    admittedBinding,
    fixtureOnlyVideo: video,
  })
}
export async function answer(offer: string) {
  if (!peer) throw Error('No peer')
  return peer.answer(offer)
}
export function admit(input: unknown) {
  const binding = RtcSessionBinding.parse(input)
  admittedTransport = binding.transport_id
  resolveBinding(binding)
}
export async function snapshot() {
  return { peer: peer?.snapshot(), video: await video?.sample() }
}
export function close() {
  peer?.close()
}
export { encodeMovingFixture } from './moving-h264-source.ts'
