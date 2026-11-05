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
let current = Promise.resolve()
let busy = false
let closing = false
lines.on('line', (line) => {
  if (closing) return
  if (busy || line.length > 65536) {
    closing = true
    output({ error: 'Fixture IPC capacity exceeded' })
    lines.close()
    return
  }
  busy = true
  current = (async () => {
    try {
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
            lifetimeMs:
              'lifetimeMs' in message && typeof message.lifetimeMs === 'number'
                ? message.lifetimeMs
                : 30000,
            deadlineMs:
              'deadlineMs' in message && typeof message.deadlineMs === 'number'
                ? message.deadlineMs
                : 8000,
          })
          // Fixture fault injection: simulate a missing native gather notification.
          if ('holdGathering' in message && message.holdGathering === true)
            active.peer.onGatheringStateChange(() => {})
          output(await active.offer())
          break
        }
        case 'answer':
          if (!active || !('sdp' in message) || typeof message.sdp !== 'string')
            throw Error('Answer missing')
          await active.answer(message.sdp)
          output({ ok: true })
          break
        case 'flood': {
          if (!active) throw Error('Peer missing')
          const frame = JSON.stringify({
            kind: 'synthetic-status',
            value: 'fixture-idle',
          })
          let sent = 0
          let sendFailure: string | undefined
          for (let i = 0; i < 1200; i++) {
            try {
              if (
                !active.channel.isOpen() ||
                !active.channel.sendMessage(frame)
              )
                break
              sent++
            } catch (error) {
              // Receiver overload closes RTC while this malicious fixture sends.
              sendFailure =
                error instanceof Error
                  ? error.message.slice(0, 64)
                  : 'fixture-send-failed'
              break
            }
          }
          output({ sent, ...(sendFailure ? { sendFailure } : {}) })
          break
        }
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
  })().finally(() => {
    busy = false
  })
})
lines.on('close', () => {
  closing = true
  void current.finally(async () => {
    await active?.close()
    cleanup()
  })
})
