import { generateKeyPairSync } from 'node:crypto'
import { createInterface } from 'node:readline'
import { cleanup, getLibraryVersion } from 'node-datachannel'
import { ConnectorIdentity } from '../../connector/src/identity/store.ts'
import { ReadonlyConnectorPeer } from '../../connector/src/webrtc/readonly-peer.ts'
const identity = new ConnectorIdentity(
  generateKeyPairSync('ed25519').privateKey,
)
let peer: ReadonlyConnectorPeer | undefined
let resolveBinding: (value: unknown) => void = () => {}
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n')
const lines = createInterface({ input: process.stdin })
let busy = false,
  closing = false
let current = Promise.resolve()
lines.on('line', (line) => {
  if (closing) return
  if (busy || line.length > 65536) {
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
            runtime: process.versions.bun ? 'bun' : 'node',
            version: process.version,
            bun: process.versions.bun,
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
          const admittedBinding = new Promise<unknown>((resolve) => {
            resolveBinding = resolve
          })
          peer = new ReadonlyConnectorPeer({
            identity,
            expectedAgentId: input.agent,
            admittedBinding,
          })
          const first = peer.offer()
          const duplicate = await peer.offer().then(
            () => 'unexpected-success',
            (error: unknown) =>
              error instanceof Error ? error.message : 'unknown',
          )
          output({ sdp: await first, duplicate })
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
          resolveBinding(input.binding)
          output({ ok: true })
          break
        case 'status':
          output({ sent: peer?.sendFixtureStatus() ?? false })
          break
        case 'snapshot':
          output(peer?.snapshot())
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
            : 'Fixture error',
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
