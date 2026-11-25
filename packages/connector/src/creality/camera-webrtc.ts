// SPDX-License-Identifier: MIT
/**
 * Creality `webrtc_local` camera (K2 family and firmware that reports
 * `webrtcSupport: 1`): one HTTP signalling exchange, then H.264 over RTP.
 * Wire facts only, no code copied. Not exercised against a printer.
 *
 * - Offer: `POST http://<ip>:8000/call/webrtc_local`, `Content-Type:
 *   plain/text`, body base64 of `{"type":"offer","sdp":…}`. CrealityOfficial/
 *   CrealityPrint@6262848e302b8c0d593f2b341cd01310aa2f58a1
 *   src/slic3r/GUI/print_manage/Routes/DeviceMgrRoutes.cpp
 *   (`get_webrtc_local_param`).
 * - Answer: base64 of `{"sdp":…}`; a video-only offer is accepted.
 *   3dg1luk43/ha_creality_ws@58c00818e8303a0d636bd05929cad215aed9ccb3
 *   custom_components/ha_creality_ws/camera.py
 *   (`_wrap_direct_offer_payload`, `_extract_direct_answer_sdp`).
 * - RTP payload: RFC 6184 (single NAL, STAP-A, FU-A).
 */
import { request } from 'node:http'
import type { CameraAccessUnit } from '../camera/session.ts'
import { selectCrealityCamera } from './camera.ts'

export const CREALITY_WEBRTC_PORT = 8000
export const CREALITY_WEBRTC_PATH = '/call/webrtc_local'
const PAYLOAD_TYPE = 96
const MAX_ANSWER_BYTES = 64 * 1024
/** The camera session refuses larger units. */
const MAX_UNIT_BYTES = 262_144
const MAX_QUEUED_UNITS = 30
const START_CODE = Buffer.from([0, 0, 0, 1])

export type CrealityWebRtcFailure =
  'signalling' | 'answer' | 'codec' | 'no-media' | 'frame'
export class CrealityWebRtcError extends Error {
  readonly reason: CrealityWebRtcFailure
  constructor(reason: CrealityWebRtcFailure) {
    super(`Creality WebRTC camera unavailable: ${reason}`)
    this.name = 'CrealityWebRtcError'
    this.reason = reason
  }
}

/**
 * Reassembles RTP packets into Annex-B access units. Nothing is emitted until a
 * keyframe; a gap or an unknown packet type waits for the next keyframe.
 */
export function createCrealityH264Depacketizer() {
  let parts: Buffer[] = []
  let size = 0
  let fragment: Buffer[] | undefined
  let sequence: number | undefined
  let timestamp: number | undefined
  let elapsed = 0
  let lastUs = -1
  let broken = false
  let synced = false
  let sps: Buffer | undefined
  let pps: Buffer | undefined

  const reset = () => {
    parts = []
    size = 0
    fragment = undefined
    broken = false
  }
  const lose = () => {
    broken = true
    synced = false
  }
  function add(nal: Buffer) {
    size += nal.length + START_CODE.length
    if (size > MAX_UNIT_BYTES) throw new CrealityWebRtcError('frame')
    parts.push(nal)
  }
  function finish(): CameraAccessUnit | undefined {
    const nals = parts
    const damaged = broken || fragment !== undefined
    reset()
    if (damaged) synced = false
    if (damaged || !nals.length) return
    const types = nals.map((nal) => nal[0]! & 31)
    sps = nals[types.indexOf(7)] ?? sps
    pps = nals[types.indexOf(8)] ?? pps
    const keyframe = types.includes(5)
    if (!synced && !keyframe) return
    // A decoder joining here needs the parameter sets with the keyframe.
    const prefix =
      keyframe && !types.includes(7) && sps && pps ? [sps, pps] : []
    if (!synced && !types.includes(7) && !prefix.length) return
    synced = true
    const data = Buffer.concat(
      [...prefix, ...nals].flatMap((nal) => [START_CODE, nal]),
    )
    if (data.length > MAX_UNIT_BYTES) throw new CrealityWebRtcError('frame')
    lastUs = Math.max(lastUs + 1, Math.round((elapsed * 100) / 9))
    return { data, keyframe, timestampUs: lastUs }
  }

  return {
    /** True while a keyframe is needed before anything can be shown. */
    get waiting() {
      return !synced
    },
    push(packet: Buffer): CameraAccessUnit[] {
      if (packet.length < 13 || packet[0]! >> 6 !== 2) return []
      // RTCP shares the port: packet types 192-223 (RFC 5761).
      if (packet[1]! >= 192 && packet[1]! <= 223) return []
      if ((packet[1]! & 127) !== PAYLOAD_TYPE) return []
      let offset = 12 + (packet[0]! & 15) * 4
      if (packet[0]! & 16) {
        if (offset + 4 > packet.length) return []
        offset += 4 + packet.readUInt16BE(offset + 2) * 4
      }
      const end =
        packet.length - (packet[0]! & 32 ? packet[packet.length - 1]! : 0)
      if (offset >= end) return []
      const payload = packet.subarray(offset, end)
      const seq = packet.readUInt16BE(2)
      const time = packet.readUInt32BE(4)
      const units: CameraAccessUnit[] = []
      if (timestamp !== undefined && time !== timestamp) {
        const unit = finish()
        if (unit) units.push(unit)
        elapsed += Math.max(0, (time - timestamp) | 0)
      }
      timestamp = time
      if (sequence !== undefined && seq !== ((sequence + 1) & 0xffff)) lose()
      sequence = seq
      const type = payload[0]! & 31
      if (type >= 1 && type <= 23) add(Buffer.from(payload))
      else if (type === 24) {
        for (let at = 1; at + 2 <= payload.length;) {
          const length = payload.readUInt16BE(at)
          at += 2
          if (!length || at + length > payload.length) {
            lose()
            break
          }
          add(Buffer.from(payload.subarray(at, at + length)))
          at += length
        }
      } else if (type === 28 && payload.length > 2) {
        const header = payload[1]!
        if (header & 0x80)
          fragment = [Buffer.from([(payload[0]! & 0xe0) | (header & 31)])]
        if (!fragment) lose()
        else {
          fragment.push(Buffer.from(payload.subarray(2)))
          if (
            fragment.reduce((sum, part) => sum + part.length, 0) + size >
            MAX_UNIT_BYTES
          )
            throw new CrealityWebRtcError('frame')
          if (header & 0x40) {
            add(Buffer.concat(fragment))
            fragment = undefined
          }
        }
      } else lose()
      if (packet[1]! & 128) {
        const unit = finish()
        if (unit) units.push(unit)
      }
      return units
    },
  }
}

/**
 * Only the configured printer may be an ICE target: a candidate naming any
 * other address is dropped, so a printer cannot point the Connector elsewhere.
 */
export function readCrealityAnswer(body: string, host: string): string {
  let sdp = body.trim()
  if (!sdp.startsWith('v=0')) {
    try {
      const value = JSON.parse(Buffer.from(sdp, 'base64').toString('utf8'))
      sdp = typeof value?.sdp === 'string' ? value.sdp : ''
    } catch {
      sdp = ''
    }
  }
  if (!sdp.startsWith('v=0')) throw new CrealityWebRtcError('answer')
  const lines = sdp
    .split(/\r?\n/)
    .filter(
      (line) =>
        line &&
        (!line.startsWith('a=candidate:') || line.split(/\s+/)[4] === host),
    )
  if (!lines.some((line) => line.startsWith('m=video ')))
    throw new CrealityWebRtcError('answer')
  if (!lines.some((line) => /^a=rtpmap:96 H264\/90000/i.test(line)))
    throw new CrealityWebRtcError('codec')
  return lines.join('\r\n') + '\r\n'
}

function signal8000(input: {
  host: string
  port: number
  offer: string
  signal: AbortSignal
}): Promise<string> {
  const body = Buffer.from(
    JSON.stringify({ type: 'offer', sdp: input.offer }),
  ).toString('base64')
  return new Promise((resolve, reject) => {
    const fail = () => reject(new CrealityWebRtcError('signalling'))
    const req = request(
      {
        host: input.host,
        port: input.port,
        path: CREALITY_WEBRTC_PATH,
        method: 'POST',
        headers: {
          'content-type': 'plain/text',
          'content-length': Buffer.byteLength(body),
        },
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        if (response.statusCode !== 200) {
          response.destroy()
          return fail()
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_ANSWER_BYTES) {
            response.destroy()
            return fail()
          }
          chunks.push(chunk)
        })
        response.on('error', fail)
        response.on('end', () =>
          resolve(Buffer.concat(chunks).toString('utf8')),
        )
      },
    )
    req.on('error', fail)
    req.end(body)
  })
}

export async function openCrealityWebRtcSource(input: {
  host: string
  port?: number | undefined
  signal: AbortSignal
  isCurrent?: () => boolean
  mediaTimeoutMs?: number
}): Promise<AsyncIterable<CameraAccessUnit>> {
  const { host, port } = selectCrealityCamera({
    host: input.host,
    port: input.port ?? CREALITY_WEBRTC_PORT,
  })
  const { PeerConnection, Video, RtcpReceivingSession } =
    await import('node-datachannel')
  return (async function* () {
    if (input.signal.aborted) return
    // LAN only: no STUN and no TURN.
    const peer = new PeerConnection('creality-camera', { iceServers: [] })
    const queue: CameraAccessUnit[] = []
    const depacketizer = createCrealityH264Depacketizer()
    let failure: CrealityWebRtcError | undefined
    let wake: () => void = () => {}
    const fail = (error: CrealityWebRtcError) => {
      failure ??= error
      wake()
    }
    const abort = () => wake()
    input.signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let media: { close(): void } | undefined
    try {
      const video = new Video('0', 'RecvOnly')
      video.addH264Codec(
        PAYLOAD_TYPE,
        'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
      )
      const track = peer.addTrack(video)
      media = track
      track.setMediaHandler(new RtcpReceivingSession())
      let askedAt = 0
      track.onMessage((packet) => {
        if (failure) return
        try {
          queue.push(...depacketizer.push(packet))
        } catch (error) {
          return fail(
            error instanceof CrealityWebRtcError
              ? error
              : new CrealityWebRtcError('frame'),
          )
        }
        if (queue.length > MAX_QUEUED_UNITS)
          return fail(new CrealityWebRtcError('frame'))
        if (depacketizer.waiting && performance.now() - askedAt > 1000) {
          askedAt = performance.now()
          try {
            track.requestKeyframe()
          } catch {
            // The printer sends its own keyframes if the request cannot go.
          }
        }
        wake()
      })
      track.onClosed(() => fail(new CrealityWebRtcError('no-media')))
      peer.onStateChange((state) => {
        if (state === 'failed' || state === 'closed')
          fail(new CrealityWebRtcError('no-media'))
      })
      const gathered = new Promise<void>((resolve) => {
        peer.onGatheringStateChange((state) => {
          if (state === 'complete') resolve()
        })
        timer = setTimeout(resolve, 3000)
        wake = resolve
      })
      peer.setLocalDescription()
      await gathered
      clearTimeout(timer)
      if (input.signal.aborted) return
      const offer = peer.localDescription()?.sdp
      if (!offer) throw new CrealityWebRtcError('signalling')
      const answer = readCrealityAnswer(
        await signal8000({ host, port, offer, signal: input.signal }),
        host,
      )
      peer.setRemoteDescription(answer, 'answer')
      while (!input.signal.aborted) {
        if (input.isCurrent && !input.isCurrent()) return
        const unit = queue.shift()
        if (unit) {
          yield unit
          continue
        }
        if (failure) throw failure
        await new Promise<void>((resolve) => {
          wake = resolve
          timer = setTimeout(
            () => fail(new CrealityWebRtcError('no-media')),
            input.mediaTimeoutMs ?? 10_000,
          )
        })
        clearTimeout(timer)
      }
    } catch (error) {
      if (!input.signal.aborted) throw error
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', abort)
      // A track that was never negotiated is not released by the peer alone.
      media?.close()
      peer.close()
    }
  })()
}
