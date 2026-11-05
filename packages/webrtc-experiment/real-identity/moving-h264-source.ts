/** Original deterministic fixture pixels and browser-generated bitstream only.
 * No third-party encoded asset, camera, RTSP connection or server relay.
 */
export const MOVING_H264_FIXTURE = Object.freeze({
  width: 128,
  height: 96,
  frames: 30,
  fps: 10,
  codec: 'avc1.42001e',
  maxUnitBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
})
export function movingPixels(frame: number): Uint8ClampedArray<ArrayBuffer> {
  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    frame >= MOVING_H264_FIXTURE.frames
  )
    throw Error('Fixture frame index')
  const { width, height } = MOVING_H264_FIXTURE
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const square =
        x >= 8 + (frame % 12) * 8 &&
        x < 24 + (frame % 12) * 8 &&
        y >= 40 &&
        y < 56
      const bit = Math.floor((x - 8) / 8)
      const counter =
        y >= 8 &&
        y < 12 &&
        x >= 8 &&
        x < 56 &&
        (x - 8) % 8 < 4 &&
        Boolean(frame & (1 << bit))
      const offset = (y * width + x) * 4,
        value = square || counter ? 255 : 0
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  return pixels
}
export type MovingAccessUnit = Readonly<{
  data: Uint8Array<ArrayBuffer>
  keyframe: boolean
  timestampUs: number
}>
/** Capability probing and encoding execute only when explicitly called in a browser. */
export async function encodeMovingFixture(): Promise<
  Readonly<{
    codec: string
    width: number
    height: number
    units: MovingAccessUnit[]
    totalBytes: number
  }>
> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined')
    throw Error('WebCodecs unavailable')
  const config: VideoEncoderConfig = {
    codec: MOVING_H264_FIXTURE.codec,
    width: MOVING_H264_FIXTURE.width,
    height: MOVING_H264_FIXTURE.height,
    framerate: MOVING_H264_FIXTURE.fps,
    bitrate: 128000,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-software',
    avc: { format: 'annexb' },
  }
  if (!(await VideoEncoder.isConfigSupported(config)).supported)
    throw Error('AnnexB H264 configuration unavailable')
  const units: MovingAccessUnit[] = []
  let totalBytes = 0,
    failure: Error | undefined
  const encoder = new VideoEncoder({
    error: (error) => {
      failure = error
    },
    output: (chunk) => {
      if (failure) return
      if (
        chunk.byteLength < 1 ||
        chunk.byteLength > MOVING_H264_FIXTURE.maxUnitBytes ||
        totalBytes + chunk.byteLength > MOVING_H264_FIXTURE.maxTotalBytes ||
        units.length === MOVING_H264_FIXTURE.frames ||
        !Number.isSafeInteger(chunk.timestamp) ||
        chunk.timestamp < 0 ||
        (units.length > 0 &&
          chunk.timestamp <= (units.at(-1)?.timestampUs ?? -1))
      ) {
        failure = Error('Encoded fixture budget')
        return
      }
      // Extraction from WebCodecs creates fixture-source bytes. Later camera
      // admission makes its single owned copy; the native sink must not copy JS again.
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      totalBytes += chunk.byteLength
      units.push(
        Object.freeze({
          data,
          keyframe: chunk.type === 'key',
          timestampUs: chunk.timestamp,
        }),
      )
    },
  })
  try {
    encoder.configure(config)
    const canvas = new OffscreenCanvas(config.width, config.height)
    const context = canvas.getContext('2d')
    if (!context) throw Error('Fixture canvas unavailable')
    for (let index = 0; index < MOVING_H264_FIXTURE.frames; index++) {
      if (failure) throw failure
      context.putImageData(
        new ImageData(movingPixels(index), config.width, config.height),
        0,
        0,
      )
      const frame = new VideoFrame(canvas, { timestamp: index * 100000 })
      try {
        encoder.encode(frame, { keyFrame: true })
      } finally {
        frame.close()
      }
      // At most one outstanding input frame. All-IDR avoids reference-frame
      // dependencies and requires each output AU to include decoder parameters.
      await encoder.flush()
    }
    if (failure) throw failure
    if (
      units.length !== MOVING_H264_FIXTURE.frames ||
      units.some((unit) => !unit.keyframe)
    )
      throw Error('Incomplete fixture encoding')
    return Object.freeze({
      codec: config.codec,
      width: config.width,
      height: config.height,
      units,
      totalBytes,
    })
  } finally {
    encoder.close()
  }
}
