// SPDX-License-Identifier: MIT
// Gated interop browser module: production browser peer + camera media.
import { ReadonlyBrowserPeer } from '../../../apps/farm/app/utils/webrtc/readonly-peer.ts'
import { BrowserCameraMedia } from '../../../apps/farm/app/utils/webrtc/camera-media.ts'
import { validateBrowserDevicePublicKey } from '../../farm-protocol/src/browser-device-proof.ts'
import type { AssignmentRef } from '../../connector/src/webrtc/readonly-session.ts'

const key = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
)
const video = document.createElement('video')
video.muted = true
video.playsInline = true
document.body.append(video)
const canvas = document.createElement('canvas')
canvas.width = 64
canvas.height = 48
let peer: ReadonlyBrowserPeer | undefined,
  camera: BrowserCameraMedia | undefined
let resolveBinding: (value: unknown) => void = () => {}
let callbacks = 0,
  printerId: string | undefined,
  attachments = 0,
  detachments = 0
const digests = new Set<string>()
let frameId: number | undefined

function onFrame() {
  frameId = video.requestVideoFrameCallback(() => {
    if (!video.srcObject) return
    callbacks++
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context && digests.size < 256) {
      context.drawImage(video, 0, 0, 64, 48)
      const pixels = context.getImageData(0, 0, 64, 48).data
      let hash = 0
      for (let i = 0; i < pixels.length; i += 4)
        hash = (hash * 31 + pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) | 0
      digests.add(String(hash))
    }
    onFrame()
  })
}

export async function identity() {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey)
  return validateBrowserDevicePublicKey({ kty, crv, x, y })
}
export function create(
  agent: string,
  refs: AssignmentRef[],
  authorized: string[],
) {
  peer?.close()
  const admittedBinding = new Promise<unknown>((resolve) => {
    resolveBinding = resolve
  })
  camera = new BrowserCameraMedia({
    privateKey: key.privateKey,
    authorizedPrinterIds: authorized,
    onStream(stream, printer) {
      if (stream) {
        attachments++
        printerId = printer
        video.srcObject = stream
        void video.play().catch(() => peer?.close('play-failed'))
        onFrame()
      } else {
        detachments++
        if (frameId !== undefined) video.cancelVideoFrameCallback(frameId)
        video.pause()
        video.srcObject = null
      }
    },
    onViolation: (reason) => peer?.close(reason),
  })
  peer = new ReadonlyBrowserPeer({
    privateKey: key.privateKey,
    expectedAgentId: agent,
    admittedBinding,
    genuineStatus: { assignmentRefs: refs },
    cameraMedia: camera,
  })
}
export function answer(offer: string) {
  if (!peer) throw Error('No peer')
  return peer.answer(offer)
}
export function admit(binding: unknown) {
  resolveBinding(binding)
}
export function snapshot() {
  const quality = video.getVideoPlaybackQuality()
  return {
    peer: peer?.snapshot(),
    camera: camera?.snapshot(),
    printerId,
    attachments,
    detachments,
    attached: video.srcObject !== null,
    decodedFrames: quality.totalVideoFrames,
    callbacks,
    distinctFrames: digests.size,
    width: video.videoWidth,
    height: video.videoHeight,
  }
}
export function close() {
  peer?.close()
}
