// SPDX-License-Identifier: MIT
/**
 * Creality camera profiles against reference-derived simulators (nothing was
 * captured from a printer). Sources are cited by creality/camera-webrtc.ts and
 * docs/fullfarmmanager/DRIVER-EVIDENCE.md.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CrealityWebRtcError,
  createCrealityH264Depacketizer,
  openCrealityWebRtcSource,
  readCrealityAnswer,
} from '../../packages/connector/src/creality/camera-webrtc.ts'
import type { CameraAccessUnit } from '../../packages/connector/src/camera/session.ts'
import { parseCameraRuntimeConfig } from '../../packages/connector/src/config/camera.ts'
import {
  createCrealityWebRtcCameraSimulator,
  simulatedRtpPacket,
  simulatedRtpPayloads,
  SIMULATED_IDR,
  SIMULATED_PPS,
  SIMULATED_SLICE,
  SIMULATED_SPS,
} from '../../packages/sim-tools/src/creality-webrtc-camera-sim.ts'

// The native WebRTC library keeps the process alive until it is released.
after(async () => (await import('node-datachannel')).cleanup())

const start = Buffer.from([0, 0, 0, 1])
const annexB = (...nals: Buffer[]) =>
  Buffer.concat(nals.flatMap((nal) => [start, nal]))

function packets(frames: number, from = 0) {
  let sequence = 0
  const all: Buffer[] = []
  for (let frame = from; frame < from + frames; frame++) {
    const payloads = simulatedRtpPayloads(frame)
    payloads.forEach((payload, index) =>
      all.push(
        simulatedRtpPacket({
          payload,
          sequence: sequence++,
          timestamp: frame * 6000,
          marker: index === payloads.length - 1,
          ssrc: 1,
        }),
      ),
    )
  }
  return all
}

test('depacketizer rebuilds Annex-B units from STAP-A, FU-A and single NALs', () => {
  const depacketizer = createCrealityH264Depacketizer()
  const units = packets(3).flatMap((packet) => depacketizer.push(packet))
  assert.deepEqual(
    units.map((unit) => unit.keyframe),
    [true, false, false],
  )
  assert.deepEqual(
    Buffer.from(units[0]!.data),
    annexB(SIMULATED_SPS, SIMULATED_PPS, SIMULATED_IDR),
  )
  assert.deepEqual(Buffer.from(units[1]!.data), annexB(SIMULATED_SLICE))
  assert.deepEqual(
    units.map((unit) => unit.timestampUs),
    [0, 66_667, 133_333],
  )
})

test('depacketizer waits for a keyframe at the start and after a lost packet', () => {
  const late = createCrealityH264Depacketizer()
  assert.deepEqual(
    packets(2, 1).flatMap((packet) => late.push(packet)),
    [],
  )
  assert.equal(late.waiting, true)

  const lossy = createCrealityH264Depacketizer()
  const all = packets(7)
  // Frames 0 to 4 are packets 0-7 (keyframe: STAP-A and two FU-A). Drop the
  // slice of frame 1: frames 2-4 depend on it and are withheld.
  all.splice(3, 1)
  const units = all.flatMap((packet) => lossy.push(packet))
  assert.deepEqual(
    units.map((unit) => unit.keyframe),
    [true, true, false],
  )
})

test('depacketizer ignores RTCP, other payload types and non-RTP bytes', () => {
  const depacketizer = createCrealityH264Depacketizer()
  const rtcp = Buffer.alloc(16)
  rtcp[0] = 0x80
  rtcp[1] = 200
  const other = Buffer.from(packets(1)[0]!)
  other[1] = 111
  for (const packet of [rtcp, other, Buffer.alloc(20), Buffer.alloc(4)])
    assert.deepEqual(depacketizer.push(packet), [])
})

test('depacketizer refuses a unit larger than the camera session accepts', () => {
  const depacketizer = createCrealityH264Depacketizer()
  assert.throws(() => {
    for (let sequence = 0; sequence < 300; sequence++)
      depacketizer.push(
        simulatedRtpPacket({
          payload: Buffer.concat([Buffer.from([0x65]), Buffer.alloc(1100)]),
          sequence,
          timestamp: 0,
          marker: false,
          ssrc: 1,
        }),
      )
  }, /frame/)
})

test('answer keeps only the printer as ICE target and requires H.264', () => {
  const sdp = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 H264/90000',
    'a=candidate:1 1 UDP 2122317823 192.168.1.50 40000 typ host',
    'a=candidate:2 1 UDP 2122317823 10.9.9.9 40001 typ host',
  ].join('\r\n')
  const wrapped = Buffer.from(JSON.stringify({ type: 'answer', sdp })).toString(
    'base64',
  )
  for (const body of [wrapped, sdp]) {
    const answer = readCrealityAnswer(body, '192.168.1.50')
    assert.match(answer, /192\.168\.1\.50/)
    assert.doesNotMatch(answer, /10\.9\.9\.9/)
  }
  assert.throws(
    () => readCrealityAnswer('not an answer', '192.168.1.50'),
    (error) =>
      error instanceof CrealityWebRtcError && error.reason === 'answer',
  )
  assert.throws(
    () => readCrealityAnswer(sdp.replace('H264', 'VP8'), '192.168.1.50'),
    (error) => error instanceof CrealityWebRtcError && error.reason === 'codec',
  )
})

test(
  'webrtc_local profile: signalling exchange then access units over loopback',
  { timeout: 30_000 },
  async () => {
    const simulator = await createCrealityWebRtcCameraSimulator()
    const controller = new AbortController()
    try {
      const source = await openCrealityWebRtcSource({
        host: '127.0.0.1',
        port: simulator.port,
        signal: controller.signal,
      })
      const units: CameraAccessUnit[] = []
      for await (const unit of source) {
        units.push(unit)
        if (units.length === 7) break
      }
      assert.equal(units[0]!.keyframe, true)
      assert.deepEqual(
        Buffer.from(units[0]!.data),
        annexB(SIMULATED_SPS, SIMULATED_PPS, SIMULATED_IDR),
      )
      assert.ok(
        units.every(
          (unit, index) =>
            !index || unit.timestampUs > units[index - 1]!.timestampUs,
        ),
      )
      assert.equal(simulator.offers.length, 1)
      const [offer] = simulator.offers
      assert.equal(offer!.contentType, 'plain/text')
      assert.equal(offer!.type, 'offer')
      assert.match(offer!.sdp, /^m=video /m)
      assert.doesNotMatch(offer!.sdp, /^m=(audio|application) /m)
    } finally {
      controller.abort()
      await simulator.close()
    }
  },
)

test('webrtc_local failures carry a reason and are not retried', async () => {
  for (const [options, reason] of [
    [{ status: 503 }, 'signalling'],
    [{ reply: 'garbage' }, 'answer'],
  ] as const) {
    const simulator = await createCrealityWebRtcCameraSimulator(options)
    try {
      const source = await openCrealityWebRtcSource({
        host: '127.0.0.1',
        port: simulator.port,
        signal: new AbortController().signal,
      })
      await assert.rejects(
        source[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof CrealityWebRtcError && error.reason === reason,
      )
      assert.equal(simulator.offers.length, 1)
    } finally {
      await simulator.close()
    }
  }
})

test('webrtc_local only contacts a private IPv4 printer', async () => {
  for (const host of ['example.com', '8.8.8.8'])
    await assert.rejects(
      openCrealityWebRtcSource({
        host,
        signal: new AbortController().signal,
      }),
      /Invalid Creality camera/,
    )
})

test('runtime configuration accepts the documented profiles and refuses the others', () => {
  const assignmentId = randomUUID()
  const parse = (source: object) =>
    parseCameraRuntimeConfig(
      {
        helper: { path: '/opt/rtsp-ingest', sha256: 'a'.repeat(64) },
        cameras: [{ cameraId: 'cam', assignmentId, source }],
      },
      [assignmentId],
    ).cameras[0]!.source
  const address = '192.168.1.50'
  assert.deepEqual(parse({ kind: 'creality-mjpeg', address, port: 8080 }), {
    kind: 'creality-mjpeg',
    address,
    port: 8080,
    path: '/?action=stream',
  })
  assert.deepEqual(parse({ kind: 'creality-webrtc', address, port: 8000 }), {
    kind: 'creality-webrtc',
    address,
    port: 8000,
    path: '/call/webrtc_local',
  })
  // `rtsp://<ip>/ch0_0` has no vendor kind: it is a plain RTSP source.
  assert.deepEqual(parse({ address, port: 554, path: '/ch0_0' }), {
    address,
    port: 554,
    path: '/ch0_0',
  })
  for (const source of [
    { kind: 'creality-webrtc', address, port: 8000, path: '/call/other' },
    { kind: 'creality-webrtc', address: '8.8.8.8', port: 8000 },
    // Encrypted signalling on the advertised videoPort is not implemented.
    { kind: 'creality-webrtc-tls', address, port: 443 },
  ])
    assert.throws(() => parse(source))
})
