import {
  Video,
  RtpPacketizationConfig,
  H264RtpPacketizer,
  type Track,
} from 'node-datachannel'
import type { FixtureOnlyMediaHooks } from '../../connector/src/webrtc/readonly-peer.ts'
import {
  FiniteMediaBudget,
  type CameraAccessUnit,
} from './finite-media-budget.ts'

/** TEST ONLY: finite ingress, not native backpressure or RSS enforcement.
 * Historical source copies outgoing bytes, but installed binary provenance does
 * not attest that behavior. This fixture cannot establish production readiness.
 */
export class FiniteNativeMediaFixture implements FixtureOnlyMediaHooks {
  #track: Track | undefined
  #config: RtpPacketizationConfig | undefined
  #budget: FiniteMediaBudget | undefined
  #terminal = false
  #activated = false
  #reason = ''
  #timer: ReturnType<typeof setTimeout> | undefined
  #options: Readonly<{
    admit: (context: Parameters<FixtureOnlyMediaHooks['activate']>[0]) => number
    onTerminal: () => void
  }>
  constructor(options: {
    admit: (context: Parameters<FixtureOnlyMediaHooks['activate']>[0]) => number
    onTerminal: () => void
  }) {
    this.#options = Object.freeze({ ...options })
  }
  prepare: FixtureOnlyMediaHooks['prepare'] = (capability) => {
    if (this.#terminal || this.#track)
      throw Error('Fixture media already prepared')
    const video = new Video('finite-fixture-video', 'SendOnly')
    video.addH264Codec(
      102,
      'profile-level-id=42001e;packetization-mode=1;level-asymmetry-allowed=1',
    )
    video.addSSRC(
      123456789,
      'finite-moving-fixture',
      'finite-stream',
      'finite-video',
    )
    const config = new RtpPacketizationConfig(
      123456789,
      'finite-moving-fixture',
      102,
      90000,
    )
    const packetizer = new H264RtpPacketizer('StartSequence', config, 1200)
    const track = capability.addVideoTrack(video)
    track.setMediaHandler(packetizer)
    track.onClosed(() => this.terminal('track-closed'))
    track.onError(() => this.terminal('track-error'))
    // No NACK responder, RTCP sender reporter, pacer or retransmission chain.
    this.#track = track
    this.#config = config
  }
  activate: FixtureOnlyMediaHooks['activate'] = (context) => {
    if (this.#terminal || this.#activated || !this.#track || !this.#config)
      throw Error('Fixture activation unavailable')
    const now = performance.now()
    const deadline = Math.min(
      this.#options.admit(context),
      context.lifetimeDeadline,
      now + context.binding.expires_at - Date.now(),
      now + 30000,
    )
    this.#budget = new FiniteMediaBudget({
      now: () => performance.now(),
      deadline,
      send: (unit) => {
        if (
          this.#terminal ||
          !this.#activated ||
          !this.#track?.isOpen() ||
          !this.#config
        )
          return false
        this.#config.timestamp = unit.rtpTimestamp
        // A view, NOT a second JS copy. It is not retained. Immediate native copy
        // is an experimental source assumption, not attested binary behavior.
        return this.#track.sendMessageBinary(
          Buffer.from(
            unit.data.buffer,
            unit.data.byteOffset,
            unit.data.byteLength,
          ),
        )
      },
    })
    this.#activated = true
    this.#timer = setTimeout(
      () => this.terminal('media-lease'),
      Math.max(0, deadline - performance.now()),
    )
  }
  trySend(unit: CameraAccessUnit) {
    if (this.#terminal) return false
    if (!this.#activated || !this.#budget) {
      this.terminal('media-before-auth')
      return false
    }
    const sent = this.#budget.trySend(unit)
    if (!sent || this.#budget.snapshot().terminal)
      this.terminal('finite-media-stop')
    return sent
  }
  private terminal(reason: string) {
    if (this.#terminal) return
    this.#reason = reason
    this.stop()
    this.#options.onTerminal()
  }
  stop = () => {
    if (this.#terminal) return
    this.#terminal = true
    this.#activated = false
    clearTimeout(this.#timer)
    this.#budget?.close()
    this.#track?.close()
  }
  snapshot() {
    return {
      terminal: this.#terminal,
      activated: this.#activated,
      trackOpen: this.#track?.isOpen() ?? false,
      reason: this.#reason,
      budget: this.#budget?.snapshot() ?? {
        terminal: false,
        frames: 0,
        bytes: 0,
      },
    }
  }
}
