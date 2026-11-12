// SPDX-License-Identifier: MIT
// Gated interop child: production Connector peer + camera media fed by the
// rtsp-ingest helper from a local simulator. IPC carries control only; media
// flows exclusively RTSP -> helper -> native WebRTC track.
import { generateKeyPairSync } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  cleanup,
  getLibraryVersion,
  Video,
  RtpPacketizationConfig,
  H264RtpPacketizer,
} from 'node-datachannel'
import { ConnectorIdentity } from '../../connector/src/identity/store.ts'
import { ReadonlyConnectorPeer } from '../../connector/src/webrtc/readonly-peer.ts'
import { ConnectorCameraMedia } from '../../connector/src/camera/camera-media.ts'
import { openHelperSource } from '../../../tools/rtsp-ingest/supervisor/process.ts'

const identity = new ConnectorIdentity(
  generateKeyPairSync('ed25519').privateKey,
)
let peer: ReadonlyConnectorPeer | undefined,
  camera: ConnectorCameraMedia | undefined,
  helperPid: number | undefined,
  helperClosed: Promise<void> | undefined
let slots = 1
let resolveBinding: (value: unknown) => void = () => {}
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n')
const text = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  if (typeof value !== 'string' || value.length > 1024)
    throw Error('Missing ' + key)
  return value
}
const lines = createInterface({ input: process.stdin })
let current = Promise.resolve()
lines.on('line', (line) => {
  current = current.then(async () => {
    try {
      const input: unknown = JSON.parse(line)
      if (!input || typeof input !== 'object') throw Error('Bad control')
      const control = input as Record<string, unknown>
      switch (control.kind) {
        case 'hello':
          output({
            version: process.version,
            pid: process.pid,
            libdatachannel: getLibraryVersion(),
            spki: identity.publicKeySpki,
            fingerprint: identity.fingerprint,
          })
          break
        case 'offer': {
          const agent = text(control, 'agent'),
            farm = text(control, 'farm'),
            assignment = text(control, 'assignment'),
            helperPath = text(control, 'helperPath'),
            helperSha256 = text(control, 'helperSha256')
          const port = Number(control.rtspPort)
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw Error('Bad port')
          const refs = [
            { assignmentId: assignment, agentId: agent, printerKey: 'sim-1' },
          ]
          peer?.close()
          camera = new ConnectorCameraMedia({
            native: { Video, RtpPacketizationConfig, H264RtpPacketizer },
            expectedAgentId: agent,
            assignmentRefs: refs,
            cameras: [
              {
                cameraId: 'sim-camera',
                scope: { farmId: farm, agentId: agent, printerId: assignment },
                sourceHandle: 'rtsp-sim',
              },
            ],
            signProof: (statement) =>
              identity.signCameraPurposeProof({
                statement,
                expectedAgentId: agent,
              }),
            async openSource(handle, signal, expiresAtMonoMs) {
              const source = await openHelperSource({
                executable: { path: helperPath, sha256: helperSha256 },
                sourceHandle: handle,
                // Private local resolution; the browser never sees this.
                resolveLocal: (value) =>
                  value === 'rtsp-sim'
                    ? { address: '127.0.0.1', port, path: '/test' }
                    : undefined,
                signal,
                expiresAtMonoMs,
                generation: 1,
                isAdmitted: () => !signal.aborted,
              })
              helperPid = source.pid
              helperClosed = source.closed.catch(() => {})
              return source
            },
            acquireSlot() {
              if (slots <= 0) return undefined
              slots--
              return () => {
                slots++
              }
            },
            onViolation: (reason) => peer?.close(reason),
          })
          const admittedBinding = new Promise<unknown>((resolve) => {
            resolveBinding = resolve
          })
          peer = new ReadonlyConnectorPeer({
            identity,
            expectedAgentId: agent,
            admittedBinding,
            genuineStatus: { assignmentRefs: refs },
            cameraMedia: camera,
          })
          output({ sdp: await peer.offer() })
          break
        }
        case 'answer':
          peer?.answer(text(control, 'sdp'))
          output({ ok: true })
          break
        case 'admit':
          resolveBinding(control.binding)
          output({ ok: true })
          break
        case 'snapshot':
          output({
            peer: peer?.snapshot(),
            camera: camera?.snapshot(),
            helperPid,
          })
          break
        case 'revoke': {
          peer?.close('camera-revoked')
          const synchronous = camera?.snapshot()
          // The supervisor owns reaping; wait for its bounded close.
          await helperClosed
          output({ ok: true, synchronous })
          break
        }
        default:
          throw Error('Unknown control')
      }
    } catch (error) {
      output({
        error: error instanceof Error ? error.message.slice(0, 256) : 'failure',
      })
    }
  })
})
lines.on('close', () => {
  void current.finally(async () => {
    peer?.close()
    await helperClosed
    cleanup()
  })
})
