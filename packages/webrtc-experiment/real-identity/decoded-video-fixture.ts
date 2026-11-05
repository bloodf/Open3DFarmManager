import type { FixtureOnlyVideoHooks } from '../../../apps/farm/app/utils/webrtc/readonly-peer.ts'

/** Local finite observer. No video is attached before both RTC role proofs.
 * After stop, callbacks are cancelled and the element detached. This does not
 * assert that native/network/decoder in-flight buffers instantly disappear.
 */
export class DecodedVideoFixture implements FixtureOnlyVideoHooks {
  #video = document.createElement('video')
  #canvas = document.createElement('canvas')
  #receiver: RTCRtpReceiver | undefined
  #stream: MediaStream | undefined
  #track: MediaStreamTrack | undefined
  #terminal = false
  #active = false
  #deadline = 0
  #callbacks = 0
  #frameId: number | undefined
  #samples: { mediaTime: number; centerX: number; brightPixels: number }[] = []
  #framesDecoded = 0
  #videoWidth = 0
  #videoHeight = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #options: Readonly<{
    admit: (context: Parameters<FixtureOnlyVideoHooks['activate']>[0]) => number
    onTerminal: () => void
  }>
  constructor(options: {
    admit: (context: Parameters<FixtureOnlyVideoHooks['activate']>[0]) => number
    onTerminal: () => void
  }) {
    this.#options = Object.freeze({ ...options })
    this.#video.muted = true
    this.#video.playsInline = true
    this.#canvas.width = 128
    this.#canvas.height = 96
  }
  onTrack: FixtureOnlyVideoHooks['onTrack'] = (event) => {
    if (this.#terminal || this.#track || event.track.kind !== 'video')
      throw Error('Unexpected fixture track')
    this.#track = event.track
    this.#receiver = event.receiver
    this.#stream = new MediaStream([event.track])
    event.track.onended = () => this.terminal()
  }
  activate: FixtureOnlyVideoHooks['activate'] = (context) => {
    if (this.#terminal || this.#active || !this.#stream)
      throw Error('Video activation unavailable')
    const now = performance.now(),
      deadline = Math.min(
        this.#options.admit(context),
        context.lifetimeDeadline,
        now + context.binding.expires_at - Date.now(),
        now + 30000,
      )
    if (!Number.isFinite(deadline) || deadline <= now)
      throw Error('Video admission expired')
    this.#deadline = deadline
    this.#active = true
    this.#video.srcObject = this.#stream
    this.#timer = setTimeout(() => this.terminal(), deadline - now)
    void this.#video.play().catch(() => this.terminal())
    this.scheduleFrame()
  }
  private scheduleFrame() {
    if (!this.current() || this.#callbacks >= 60) return
    this.#frameId = this.#video.requestVideoFrameCallback((_, metadata) => {
      if (!this.current()) return
      this.#callbacks++
      this.#videoWidth = this.#video.videoWidth
      this.#videoHeight = this.#video.videoHeight
      const context = this.#canvas.getContext('2d', {
        willReadFrequently: true,
      })
      if (!context) {
        this.terminal()
        return
      }
      context.drawImage(this.#video, 0, 0, 128, 96)
      const pixels = context.getImageData(0, 40, 128, 16).data
      let sum = 0,
        count = 0
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 128; x++) {
          const offset = (y * 128 + x) * 4
          if (
            (pixels[offset] ?? 0) > 180 &&
            (pixels[offset + 1] ?? 0) > 180 &&
            (pixels[offset + 2] ?? 0) > 180
          ) {
            sum += x
            count++
          }
        }
      if (this.#samples.length === 16) this.#samples.shift()
      this.#samples.push({
        mediaTime: metadata.mediaTime,
        centerX: count ? sum / count : -1,
        brightPixels: count,
      })
      this.scheduleFrame()
    })
  }
  async sample() {
    if (this.current() && this.#receiver) {
      const stats = await this.#receiver.getStats()
      if (this.current())
        stats.forEach((report) => {
          if (
            report.type === 'inbound-rtp' &&
            report.kind === 'video' &&
            typeof report.framesDecoded === 'number' &&
            Number.isSafeInteger(report.framesDecoded)
          )
            this.#framesDecoded = Math.min(
              100000,
              Math.max(this.#framesDecoded, report.framesDecoded),
            )
        })
    }
    return this.snapshot()
  }
  private current() {
    if (!this.#active || this.#terminal) return false
    if (performance.now() >= this.#deadline) {
      this.terminal()
      return false
    }
    return true
  }
  private terminal() {
    if (this.#terminal) return
    this.stop()
    this.#options.onTerminal()
  }
  stop = () => {
    if (this.#terminal) return
    this.#terminal = true
    this.#active = false
    clearTimeout(this.#timer)
    if (this.#frameId !== undefined)
      this.#video.cancelVideoFrameCallback(this.#frameId)
    this.#video.pause()
    this.#video.srcObject = null
    if (this.#track) {
      this.#track.onended = null
      this.#track.stop()
    }
    this.#stream = undefined
    this.#receiver = undefined
  }
  snapshot() {
    return {
      terminal: this.#terminal,
      active: this.#active,
      attached: this.#video.srcObject !== null,
      callbacks: this.#callbacks,
      framesDecoded: this.#framesDecoded,
      videoWidth: this.#videoWidth,
      videoHeight: this.#videoHeight,
      samples: this.#samples.map((sample) => ({ ...sample })),
    }
  }
}
