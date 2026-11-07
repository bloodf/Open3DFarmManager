import { PeerConnection, type DataChannel } from 'node-datachannel'
import { ConnectorIdentity } from '../identity/store.ts'
import {
  ControlSessionBinding,
  controlBindingFromDescriptions,
  controlDtlsFingerprint,
  validateControlSessionBinding,
} from '../../../farm-protocol/src/control-session-binding.ts'
import { MAX_PAUSE_CHANNEL_WIRE_BYTES } from '../../../farm-protocol/src/pause-channel.ts'
import {
  captureEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from './rtc-descriptions.ts'
import {
  PauseControlSession,
  PauseExpectedContext,
  PAUSE_PENDING_BYTES,
  pauseSynchronous,
  assertPauseExpected,
  checkPauseEffectiveDescriptions,
  type PausePhaseFrame,
  type PausePhaseMessage,
  type PauseProofsReady,
  type PauseDataFrame,
  type PauseResultMessage,
} from './pause-control-session.ts'

type Options = Readonly<{
  identity: ConnectorIdentity
  expected: PauseExpectedContext
  /** Only the authenticated current signalling owner may resolve this promise. */
  expectedBinding: Promise<unknown>
  authDeadline?: number
  lifetimeDeadline?: number
  onProofsReady?: (value: PauseProofsReady) => void
  onPhase?: (frame: Readonly<PausePhaseFrame>) => void
  /** Optional command handler. Absent keeps the peer metadata only. */
  onData?: (frame: Readonly<PauseDataFrame>) => void
  onTerminal?: (reason: string) => void
}>
const noop = () => {}
function controlOnly(sdp: string): void {
  controlDtlsFingerprint(sdp)
  if ((sdp.match(/^m=/gm)?.length ?? 0) !== 1 || !/^m=application /m.test(sdp))
    throw Error('Control-only SDP required')
}
/** Separate control transport. Possession/readiness is not a capability or dispatch grant. */
export class PauseConnectorPeer {
  readonly closed: Promise<void>
  #resolveClosed: () => void = noop
  #peer: PeerConnection | undefined
  #channel: DataChannel | undefined
  #session: PauseControlSession
  #options: Options
  #expected: Promise<ControlSessionBinding | undefined>
  #validation: Promise<ControlSessionBinding> | undefined
  #activation: Promise<void> | undefined
  #offerWork: Promise<string> | undefined
  #binding: ControlSessionBinding | undefined
  #effective: EffectiveRtcDescriptions | undefined
  #terminal: string | undefined
  #offerStarted = false
  #answerStarted = false
  #offer: string | undefined
  #answer: string | undefined
  #starting = false
  #certificateMatched = false
  #closeCount = 0
  #cleanupFailures = 0
  #gathered: Promise<void>
  #resolveGathered: () => void = noop
  #terminated: Promise<void>
  #resolveTerminated: () => void = noop
  constructor(input: Options) {
    const expected = Object.freeze(PauseExpectedContext.parse(input.expected))
    if (!(input.identity instanceof ConnectorIdentity))
      throw Error('Connector identity required')
    this.#options = Object.freeze({ ...input, expected })
    this.#gathered = new Promise((resolve) => {
      this.#resolveGathered = resolve
    })
    this.#terminated = new Promise((resolve) => {
      this.#resolveTerminated = resolve
    })
    this.#session = new PauseControlSession({
      role: 'connector',
      identity: input.identity,
      expected,
      ...(input.authDeadline !== undefined
        ? { authDeadline: input.authDeadline }
        : {}),
      ...(input.lifetimeDeadline !== undefined
        ? { lifetimeDeadline: input.lifetimeDeadline }
        : {}),
      send: (wire) => this.sendWire(wire),
      onProofsReady: (value) => {
        if (this.current()) return this.#options.onProofsReady?.(value)
      },
      onPhase: (frame) => {
        if (this.current()) return this.#options.onPhase?.(frame)
      },
      ...(this.#options.onData
        ? {
            onData: (frame: Readonly<PauseDataFrame>) => {
              if (this.current()) return this.#options.onData?.(frame)
            },
          }
        : {}),
      onTerminal: (reason) => this.close(reason),
    })
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    const weak = new WeakRef(this)
    this.#expected = Promise.resolve(input.expectedBinding)
      .then(async (value) => {
        const owner = weak.deref()
        if (!owner?.current()) return undefined
        owner.#validation = validateControlSessionBinding(value)
        const binding = await owner.#validation
        if (!owner.current()) return undefined
        assertPauseExpected(binding, expected)
        Object.freeze(binding.browser_public_key)
        return Object.freeze(binding)
      })
      .catch(() => {
        weak.deref()?.close('binding-rejected')
        return undefined
      })
    try {
      this.#peer = new PeerConnection('pause-connector', {
        iceServers: [],
        bindAddress: '127.0.0.1',
        enableIceTcp: false,
        disableAutoNegotiation: true,
        disableFingerprintVerification: false,
        maxMessageSize: MAX_PAUSE_CHANNEL_WIRE_BYTES,
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
        } finally {
          this.close('unexpected-channel')
        }
      })
      this.#peer.onTrack((track) => {
        try {
          track.close()
        } catch {
          this.#cleanupFailures++
        } finally {
          this.close('unexpected-media')
        }
      })
      this.#channel = this.#peer.createDataChannel('pause-control-v1', {
        unordered: false,
      })
      this.#channel.onOpen(() => this.start())
      this.#channel.onMessage((raw) => {
        if (this.current()) this.#session.receive(raw)
      })
      this.#channel.onClosed(() => this.close('channel-closed'))
      this.#channel.onError(() => this.close('channel-error'))
    } catch (error) {
      this.close('construction-failed')
      throw error
    }
  }
  private current(): boolean {
    if (this.#terminal || !this.#session.active) return false
    if (this.#effective && this.#peer) {
      try {
        const current = captureEffectiveRtcDescriptions(
          this.#peer.localDescription(),
          this.#peer.remoteDescription(),
        )
        if (this.#binding)
          checkPauseEffectiveDescriptions(
            this.#binding,
            'connector',
            this.#effective,
            current,
          )
        else if (
          current.local.type !== this.#effective.local.type ||
          current.remote.type !== this.#effective.remote.type ||
          current.local.sdp !== this.#effective.local.sdp ||
          current.remote.sdp !== this.#effective.remote.sdp
        )
          throw Error('Descriptions changed')
      } catch {
        this.close('description-changed')
        return false
      }
    }
    return this.#session.active
  }
  offer(): Promise<string> {
    if (this.#offerWork)
      return Promise.reject(Error('Control offer unavailable'))
    this.#offerWork = this.createOffer()
    return this.#offerWork
  }
  private async createOffer(): Promise<string> {
    if (!this.current() || this.#offerStarted || !this.#peer)
      throw Error('Control offer unavailable')
    this.#offerStarted = true
    try {
      this.#peer.setLocalDescription('offer')
      await this.#gathered
      if (!this.current()) throw Error('Control offer expired')
      const local = this.#peer.localDescription()
      if (!local) throw Error('Control offer missing')
      controlOnly(local.sdp)
      this.#offer = local.sdp
      return local.sdp
    } catch (error) {
      this.close('offer-failed')
      throw error
    }
  }
  answer(sdp: string): void {
    if (!this.current() || this.#answerStarted || !this.#offer || !this.#peer) {
      this.close('answer-state')
      throw Error('Control answer unavailable')
    }
    this.#answerStarted = true
    try {
      controlOnly(sdp)
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
      !this.current() ||
      this.#starting ||
      !this.#offer ||
      !this.#answer ||
      !this.#channel?.isOpen()
    )
      return
    this.#starting = true
    this.#activation = this.activate(this.#offer, this.#answer).catch(() =>
      this.close('certificate-or-binding'),
    )
  }
  private async activate(local: string, remote: string): Promise<void> {
    const expected = await Promise.race([
      this.#expected,
      this.#terminated.then(() => undefined),
    ])
    if (!expected || !this.current()) return
    const binding = await controlBindingFromDescriptions(
      expected,
      'connector',
      local,
      remote,
    )
    if (!this.current() || !this.#peer) return
    this.#binding = binding
    if (!this.current()) return
    const actual = this.#peer.remoteFingerprint()
    if (
      actual.algorithm !== 'sha-256' ||
      actual.value.toUpperCase() !== binding.browser_dtls
    )
      throw Error('Actual control certificate mismatch')
    this.#certificateMatched = true
    if (this.current()) await this.#session.activate(binding)
  }
  private sendWire(wire: string): void {
    const channel = this.#channel,
      size = new TextEncoder().encode(wire).byteLength
    if (
      !this.current() ||
      !channel?.isOpen() ||
      size > MAX_PAUSE_CHANNEL_WIRE_BYTES
    )
      throw Error('Control channel unavailable')
    const buffered = channel.bufferedAmount()
    if (
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      buffered + size > PAUSE_PENDING_BYTES
    )
      throw Error('Control outbound limit')
    if (!this.current()) throw Error('Control deadline')
    if (!channel.sendMessage(wire)) throw Error('Control send failed')
    const after = channel.bufferedAmount()
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > PAUSE_PENDING_BYTES
    )
      throw Error('Control outbound limit')
  }
  sendPhase(input: PausePhaseMessage): boolean {
    return this.current() && this.#session.sendPhase(input)
  }
  /** Connector only result. The peer never emits a command. */
  sendResult(result: PauseResultMessage): boolean {
    if (!this.#options.onData) return false
    return this.current() && this.#session.sendResult(result)
  }
  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#closeCount++
    this.#resolveTerminated()
    this.#resolveGathered()
    this.#session.close(this.#terminal)
    for (const cleanup of [
      () => this.#channel?.onMessage(noop),
      () => this.#channel?.close(),
      () => this.#peer?.close(),
    ]) {
      try {
        cleanup()
      } catch {
        this.#cleanupFailures++
      }
    }
    try {
      pauseSynchronous(() => this.#options.onTerminal?.(this.#terminal!))
    } catch {
      this.#cleanupFailures++
    }
    void Promise.allSettled([
      this.#session.closed,
      ...(this.#activation ? [this.#activation] : []),
      ...(this.#validation ? [this.#validation] : []),
      ...(this.#offerWork ? [this.#offerWork] : []),
    ]).then(() => this.#resolveClosed())
  }
  diagnostics() {
    return Object.freeze({
      ...this.#session.diagnostics(),
      certificateMatched: this.#certificateMatched,
      closeCount: this.#closeCount,
      cleanupFailures: this.#cleanupFailures,
    })
  }
}
