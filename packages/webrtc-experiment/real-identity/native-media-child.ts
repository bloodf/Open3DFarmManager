// Local finite test control only. IPC supplies original fixture-source bytes;
// media acceptance later must be observed over the native WebRTC video track.
import { generateKeyPairSync } from 'node:crypto'
import { createInterface } from 'node:readline'
import { cleanup, getLibraryVersion } from 'node-datachannel'
import { ConnectorIdentity } from '../../connector/src/identity/store.ts'
import { ReadonlyConnectorPeer } from '../../connector/src/webrtc/readonly-peer.ts'
import { RtcSessionBinding } from '../../farm-protocol/src/rtc-session-binding.ts'
import { FiniteNativeMediaFixture } from './native-media-fixture.ts'
const identity = new ConnectorIdentity(
  generateKeyPairSync('ed25519').privateKey,
)
let peer: ReadonlyConnectorPeer | undefined,
  media: FiniteNativeMediaFixture | undefined
let admittedTransport: string | undefined
let resolveBinding: (value: unknown) => void = () => {}
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n')
const lines = createInterface({ input: process.stdin })
let busy = false,
  closing = false,
  current = Promise.resolve()
lines.on('line', (line) => {
  if (closing) return
  if (busy || line.length > 360000) {
    closing = true
    lines.close()
    return
  }
  busy = true
  current = (async () => {
    try {
      const input: unknown = JSON.parse(line)
      if (!input || typeof input !== 'object' || !('kind' in input))
        throw Error('Missing kind')
      switch (input.kind) {
        case 'hello':
          output({
            version: process.version,
            executable: process.execPath,
            pid: process.pid,
            libdatachannel: getLibraryVersion(),
            spki: identity.publicKeySpki,
            fingerprint: identity.fingerprint,
          })
          break
        case 'offer': {
          if (!('agent' in input) || typeof input.agent !== 'string')
            throw Error('Missing trusted agent')
          peer?.close()
          admittedTransport = undefined
          media = new FiniteNativeMediaFixture({
            admit: ({ binding }) => {
              if (binding.transport_id !== admittedTransport)
                throw Error('Fixture media admission absent')
              return performance.now() + 5000
            },
            onTerminal: () => peer?.close('finite-media-terminal'),
          })
          const admittedBinding = new Promise<unknown>((resolve) => {
            resolveBinding = resolve
          })
          peer = new ReadonlyConnectorPeer({
            identity,
            expectedAgentId: input.agent,
            admittedBinding,
            fixtureOnlyMedia: media,
          })
          output({ sdp: await peer.offer() })
          break
        }
        case 'answer':
          if (!peer || !('sdp' in input) || typeof input.sdp !== 'string')
            throw Error('Missing answer')
          peer.answer(input.sdp)
          output({ ok: true })
          break
        case 'admit':
          if (!('binding' in input)) throw Error('Missing admission')
          admittedTransport = RtcSessionBinding.parse(
            input.binding,
          ).transport_id
          resolveBinding(input.binding)
          output({ ok: true })
          break
        case 'media': {
          if (
            !media ||
            !('data' in input) ||
            typeof input.data !== 'string' ||
            input.data.length > 349528 ||
            !('timestampUs' in input) ||
            typeof input.timestampUs !== 'number' ||
            !('keyframe' in input) ||
            typeof input.keyframe !== 'boolean'
          )
            throw Error('Malformed fixture unit')
          const data = Buffer.from(input.data, 'base64')
          if (data.toString('base64') !== input.data)
            throw Error('Noncanonical fixture bytes')
          output({
            sent: media.trySend({
              data,
              keyframe: input.keyframe,
              timestampUs: input.timestampUs,
            }),
          })
          break
        }
        case 'snapshot':
          output({ peer: peer?.snapshot(), media: media?.snapshot() })
          break
        case 'revoke':
          peer?.close('fixture-media-revoked')
          output({ ok: true })
          break
        case 'close':
          peer?.close()
          output({ ok: true })
          break
        default:
          throw Error('Unknown fixture control')
      }
    } catch (error) {
      output({
        error:
          error instanceof Error
            ? error.message.slice(0, 256)
            : 'Fixture failure',
      })
    }
  })().finally(() => {
    busy = false
  })
})
lines.on('close', () => {
  closing = true
  void current.finally(() => {
    peer?.close()
    cleanup()
  })
})
