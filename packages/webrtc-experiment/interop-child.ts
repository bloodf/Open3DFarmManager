import { cleanup, getLibraryVersion } from 'node-datachannel'
import { createInterface } from 'node:readline'
import { SyntheticConnectorPeer } from '../connector/src/webrtc/synthetic-peer.ts'
import {
  encodeHex,
  decodeHex,
  type Scope,
} from '../connector/src/webrtc/synthetic-session.ts'
const identity = await crypto.subtle.generateKey('Ed25519', false, [
  'sign',
  'verify',
])
let active: SyntheticConnectorPeer | undefined
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n')
function parseScope(value: unknown): Scope {
  if (
    !value ||
    typeof value !== 'object' ||
    !('session' in value) ||
    typeof value.session !== 'string' ||
    !('browserNonce' in value) ||
    typeof value.browserNonce !== 'string' ||
    !('connectorNonce' in value) ||
    typeof value.connectorNonce !== 'string' ||
    !('browserSpki' in value) ||
    typeof value.browserSpki !== 'string' ||
    !('connectorSpki' in value) ||
    typeof value.connectorSpki !== 'string'
  )
    throw Error('Scope missing')
  return {
    session: value.session,
    browserNonce: value.browserNonce,
    connectorNonce: value.connectorNonce,
    browserSpki: value.browserSpki,
    connectorSpki: value.connectorSpki,
  }
}
const lines = createInterface({ input: process.stdin })
let queue = Promise.resolve()
lines.on('line', (line) => {
  queue = queue.then(async () => {
    try {
      if (line.length > 65536) throw Error('Fixture IPC size limit')
      const message: unknown = JSON.parse(line)
      if (!message || typeof message !== 'object' || !('kind' in message))
        throw Error('Fixture IPC missing kind')
      switch (message.kind) {
        case 'hello':
          output({
            runtime: process.versions.bun ? 'bun' : 'node',
            version: process.version,
            bun: process.versions.bun,
            executable: process.execPath,
            pid: process.pid,
            libdatachannel: getLibraryVersion(),
            spki: encodeHex(
              await crypto.subtle.exportKey('spki', identity.publicKey),
            ),
          })
          break
        case 'offer': {
          if (!('scope' in message)) throw Error('Scope missing')
          await active?.close()
          const scope = parseScope(message.scope)
          const remotePublicKey = await crypto.subtle.importKey(
            'spki',
            decodeHex(scope.browserSpki),
            'Ed25519',
            false,
            ['verify'],
          )
          active = new SyntheticConnectorPeer({
            scope,
            privateKey: identity.privateKey,
            remotePublicKey,
            deadlineMs: 8000,
          })
          output(await active.offer())
          break
        }
        case 'answer':
          if (!active || !('sdp' in message) || typeof message.sdp !== 'string')
            throw Error('Answer missing')
          await active.answer(message.sdp)
          output({ ok: true })
          break
        case 'snapshot':
          output(active?.snapshot())
          break
        case 'close':
          await active?.close()
          output(active?.snapshot())
          break
        default:
          throw Error('Unknown fixture IPC operation')
      }
    } catch (error) {
      output({
        error: error instanceof Error ? error.message : 'Fixture IPC error',
        snapshot: active?.snapshot(),
      })
    }
  })
})
lines.on('close', () => {
  void queue.finally(async () => {
    await active?.close()
    cleanup()
  })
})
