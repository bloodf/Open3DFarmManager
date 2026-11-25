// SPDX-License-Identifier: MIT
/**
 * Reference-derived, not captured: the `webrtc_local` exchange as the clients
 * send and read it (CrealityOfficial/CrealityPrint@6262848e302b8c0d593f2b341cd
 * 01310aa2f58a1 DeviceMgrRoutes.cpp `get_webrtc_local_param`;
 * 3dg1luk43/ha_creality_ws@58c00818e8303a0d636bd05929cad215aed9ccb3
 * camera.py). The video payload is synthetic bytes in RFC 6184 framing; it is
 * not decodable H.264 and says nothing about a printer's profile or rate.
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)

const PAYLOAD_TYPE = 96
export const SIMULATED_SPS = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0x01])
export const SIMULATED_PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80])
export const SIMULATED_IDR = Buffer.concat([
  Buffer.from([0x65]),
  Buffer.alloc(1800, 0x11),
])
export const SIMULATED_SLICE = Buffer.from([0x41, 0x9a, 0x22, 0x33])

/** One simulated access unit as RTP payloads: parameter sets then picture. */
export function simulatedRtpPayloads(frame: number): Buffer[] {
  if (frame % 5) return [SIMULATED_SLICE]
  const stap = Buffer.concat([
    Buffer.from([24]),
    ...[SIMULATED_SPS, SIMULATED_PPS].flatMap((nal) => [
      Buffer.from([nal.length >> 8, nal.length & 255]),
      nal,
    ]),
  ])
  // FU-A: the picture is larger than one packet.
  const body = SIMULATED_IDR.subarray(1)
  const fragments: Buffer[] = []
  for (let at = 0; at < body.length; at += 900) {
    const flags = (at ? 0 : 0x80) | (at + 900 >= body.length ? 0x40 : 0)
    fragments.push(
      Buffer.concat([
        Buffer.from([0x60 | 28, flags | 5]),
        body.subarray(at, at + 900),
      ]),
    )
  }
  return [stap, ...fragments]
}

export function simulatedRtpPacket(input: {
  payload: Buffer
  sequence: number
  timestamp: number
  marker: boolean
  ssrc: number
}): Buffer {
  const header = Buffer.alloc(12)
  header[0] = 0x80
  header[1] = (input.marker ? 0x80 : 0) | PAYLOAD_TYPE
  header.writeUInt16BE(input.sequence & 0xffff, 2)
  header.writeUInt32BE(input.timestamp >>> 0, 4)
  header.writeUInt32BE(input.ssrc >>> 0, 8)
  return Buffer.concat([header, input.payload])
}

export async function createCrealityWebRtcCameraSimulator(
  options: {
    /** HTTP status of the signalling reply. */
    status?: number
    /** Replaces the base64 reply body. */
    reply?: string
    frameIntervalMs?: number
  } = {},
) {
  const {
    PeerConnection,
    Video,
  }: typeof import('node-datachannel') = require('node-datachannel')
  const offers: Array<{
    method: string | undefined
    url: string | undefined
    contentType: string | undefined
    type: unknown
    sdp: string
  }> = []
  const peers = new Set<InstanceType<typeof PeerConnection>>()
  const timers = new Set<ReturnType<typeof setInterval>>()

  async function answer(offerSdp: string) {
    const peer = new PeerConnection('creality-camera-sim', { iceServers: [] })
    peers.add(peer)
    const ssrc = 4242
    const video = new Video('0', 'SendOnly')
    video.addH264Codec(
      PAYLOAD_TYPE,
      'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
    )
    video.addSSRC(ssrc, 'camera', 'camera-stream', 'camera-track')
    const track = peer.addTrack(video)
    const gathered = new Promise<void>((resolve) => {
      peer.onGatheringStateChange((state) => {
        if (state === 'complete') resolve()
      })
      const timer = setTimeout(resolve, 3000)
      timer.unref()
    })
    peer.setRemoteDescription(offerSdp, 'offer')
    await gathered
    let frame = 0
    let sequence = 0
    const timer = setInterval(() => {
      if (!track.isOpen()) return
      const payloads = simulatedRtpPayloads(frame)
      payloads.forEach((payload, index) =>
        track.sendMessageBinary(
          simulatedRtpPacket({
            payload,
            sequence: sequence++,
            timestamp: frame * 6000,
            marker: index === payloads.length - 1,
            ssrc,
          }),
        ),
      )
      frame++
    }, options.frameIntervalMs ?? 66)
    timers.add(timer)
    return peer.localDescription()!.sdp
  }

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    try {
      if (request.method !== 'POST' || request.url !== '/call/webrtc_local') {
        response.writeHead(404).end()
        return
      }
      const offer = JSON.parse(
        Buffer.from(Buffer.concat(chunks).toString(), 'base64').toString(),
      ) as { type: unknown; sdp: string }
      offers.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        type: offer.type,
        sdp: offer.sdp,
      })
      if (options.status !== undefined && options.status !== 200) {
        response.writeHead(options.status).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(
        options.reply ??
          Buffer.from(
            JSON.stringify({ type: 'answer', sdp: await answer(offer.sdp) }),
          ).toString('base64'),
      )
    } catch {
      response.writeHead(400).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: (server.address() as import('node:net').AddressInfo).port,
    offers,
    async close() {
      for (const timer of timers) clearInterval(timer)
      for (const peer of peers) peer.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
