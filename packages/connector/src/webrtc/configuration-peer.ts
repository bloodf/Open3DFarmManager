import { PeerConnection, type DataChannel } from 'node-datachannel'
import { controlDtlsFingerprint } from '../../../farm-protocol/src/control-session-binding.ts'
import { rtcBindAddress } from '../config/rtc.ts'
import {
  CONFIGURATION_CHANNEL_LABEL,
  MAX_CONFIGURATION_CHANNEL_BYTES,
} from './configuration-channel.ts'
import type { ConfigurationConnectorSession } from './configuration-session.ts'
import {
  captureEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from './rtc-descriptions.ts'

const PENDING_BYTES = 4 * MAX_CONFIGURATION_CHANNEL_BYTES
const noop = () => {}

function applicationOnly(sdp: string): void {
  controlDtlsFingerprint(sdp)
  if ((sdp.match(/^m=/gm)?.length ?? 0) !== 1 || !/^m=application /m.test(sdp))
    throw new Error('Configuration data-channel-only SDP required')
  if (/ typ relay/.test(sdp)) throw new Error('Relay candidates refused')
}

export interface ConfigurationPeerOptions {
  /** Local ICE bind address from validated config. Default loopback. */
  bindAddress?: string
  /** Builds the session with the peer's bounded sender. */
  session: (send: (wire: string) => void) => ConfigurationConnectorSession
  /** Resolved only by the authenticated signalling owner (`config.binding`). */
  binding: Promise<unknown>
}

/**
 * Dedicated config-v1 RTC transport. One Connector-created ordered channel
 * with an explicit label; no ICE servers (no TURN/STUN), no media, no
 * browser-created channel. The session sees the exact negotiated descriptions
 * and the actual remote DTLS certificate fingerprint.
 */
export class ConfigurationConnectorPeer {
  readonly closed: Promise<void>
  readonly session: ConfigurationConnectorSession
  #peer: PeerConnection | undefined
  #channel: DataChannel | undefined
  #terminal: string | undefined
  #resolveClosed: () => void = noop
  #resolveGathered: () => void = noop
  #gathered: Promise<void>
  #offer: string | undefined
  #answer: string | undefined
  #effective: EffectiveRtcDescriptions | undefined
  #started = false
  #binding: Promise<unknown>
  #cleanupFailures = 0

  constructor(options: ConfigurationPeerOptions) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#gathered = new Promise((resolve) => {
      this.#resolveGathered = resolve
    })
    this.session = options.session((wire) => this.send(wire))
    void this.session.closed.then(() => this.close('session-closed'))
    this.#binding = Promise.resolve(options.binding)
    this.#binding.catch(() => this.close('binding-rejected'))
    try {
      this.#peer = new PeerConnection('configuration-connector', {
        iceServers: [],
        bindAddress: rtcBindAddress(options.bindAddress),
        enableIceTcp: false,
        disableAutoNegotiation: true,
        disableFingerprintVerification: false,
        maxMessageSize: MAX_CONFIGURATION_CHANNEL_BYTES,
      })
      this.#peer.onGatheringStateChange((state) => {
        if (state === 'complete') this.#resolveGathered()
      })
      this.#peer.onStateChange((state) => {
        if (['closed', 'failed', 'disconnected'].includes(state))
          this.close('transport-closed')
      })
      this.#peer.onDataChannel((channel) => {
        try {
          channel.close()
        } catch {
          this.#cleanupFailures++
        }
        this.close('unexpected-channel')
      })
      this.#peer.onTrack((track) => {
        try {
          track.close()
        } catch {
          this.#cleanupFailures++
        }
        this.close('unexpected-media')
      })
      this.#channel = this.#peer.createDataChannel(
        CONFIGURATION_CHANNEL_LABEL,
        { unordered: false },
      )
      this.#channel.onOpen(() => this.start())
      this.#channel.onMessage((raw) => {
        if (this.current()) this.session.receive(raw)
      })
      this.#channel.onClosed(() => this.close('channel-closed'))
      this.#channel.onError(() => this.close('channel-error'))
    } catch (error) {
      this.close('construction-failed')
      throw error
    }
  }

  private current(): boolean {
    if (this.#terminal || !this.#peer) return false
    if (this.#effective) {
      try {
        const now = captureEffectiveRtcDescriptions(
          this.#peer.localDescription(),
          this.#peer.remoteDescription(),
        )
        if (
          now.local.sdp !== this.#effective.local.sdp ||
          now.remote.sdp !== this.#effective.remote.sdp ||
          now.local.type !== 'offer' ||
          now.remote.type !== 'answer'
        )
          throw new Error('Descriptions changed')
      } catch {
        this.close('description-changed')
        return false
      }
    }
    return true
  }

  async offer(): Promise<string> {
    if (!this.current() || this.#offer !== undefined || !this.#peer)
      throw new Error('Configuration offer unavailable')
    this.#offer = ''
    try {
      this.#peer.setLocalDescription('offer')
      await this.#gathered
      const local = this.#peer.localDescription()
      if (!this.current() || !local) throw new Error('Offer unavailable')
      applicationOnly(local.sdp)
      this.#offer = local.sdp
      return local.sdp
    } catch (error) {
      this.close('offer-failed')
      throw error
    }
  }

  answer(sdp: string): void {
    if (!this.current() || !this.#offer || this.#answer || !this.#peer) {
      this.close('answer-state')
      throw new Error('Configuration answer unavailable')
    }
    try {
      applicationOnly(sdp)
      this.#peer.setRemoteDescription(sdp, 'answer')
      this.#effective = captureEffectiveRtcDescriptions(
        this.#peer.localDescription(),
        this.#peer.remoteDescription(),
      )
      this.#answer = sdp
      this.start()
    } catch (error) {
      this.close('answer-failed')
      throw error
    }
  }

  private start(): void {
    if (
      this.#started ||
      !this.current() ||
      !this.#offer ||
      !this.#answer ||
      !this.#channel?.isOpen()
    )
      return
    this.#started = true
    const offer = this.#offer
    const answer = this.#answer
    void this.#binding
      .then((binding) => {
        if (!this.current() || !this.#peer) return
        const actual = this.#peer.remoteFingerprint()
        if (actual.algorithm !== 'sha-256')
          return this.close('certificate-mismatch')
        return this.session.activate(
          binding,
          { localSdp: offer, remoteSdp: answer },
          actual.value,
        )
      })
      .catch(() => this.close('activation-failed'))
  }

  private send(wire: string): void {
    const channel = this.#channel
    const size = new TextEncoder().encode(wire).byteLength
    if (!this.current() || !channel?.isOpen())
      throw new Error('Configuration channel unavailable')
    const buffered = channel.bufferedAmount()
    if (
      size > MAX_CONFIGURATION_CHANNEL_BYTES ||
      !Number.isSafeInteger(buffered) ||
      buffered + size > PENDING_BYTES
    )
      throw new Error('Configuration outbound limit')
    if (!channel.sendMessage(wire)) throw new Error('Configuration send failed')
  }

  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#resolveGathered()
    this.session.close(this.#terminal)
    for (const cleanup of [
      () => this.#channel?.onMessage(noop),
      () => this.#channel?.close(),
      () => this.#peer?.close(),
    ])
      try {
        cleanup()
      } catch {
        this.#cleanupFailures++
      }
    void this.session.closed.then(() => this.#resolveClosed())
  }

  diagnostics() {
    return Object.freeze({
      terminal: this.#terminal ?? null,
      sessionState: this.session.state,
      cleanupFailures: this.#cleanupFailures,
    })
  }
}
