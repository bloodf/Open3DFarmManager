import { rtcBindAddress } from '../config/rtc.ts'
import {
  captureEffectiveRtcDescriptions,
  checkEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from './rtc-descriptions.ts'
import {
  PeerConnection,
  type DataChannel,
  type Video,
  type Track,
} from 'node-datachannel'
import { ConnectorIdentity } from '../identity/store.ts'
import {
  RtcSessionBinding,
  rtcBindingFromDescriptions,
  rtcDtlsFingerprint,
  MAX_RTC_PROOF_WIRE_BYTES,
} from '../../../farm-protocol/src/rtc-session-binding.ts'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { RtcProofInbox, boundRtcApplicationFrame } from './rtc-proof-inbox.ts'
import {
  ReadonlyRtcSession,
  immutableAdmission,
  runSynchronous,
  snapshotAssignmentRefs,
  type VerifiedRtcAdmission,
  type GenuineStatusOptions,
} from './readonly-session.ts'

/** Media hooks. Track and channel reservations close before the offer; activate
 * runs only after both RTC role proofs. Fixture hooks grant no camera authority;
 * camera hooks must verify their own camera-purpose proofs before sending media. */
export type FixtureOnlyMediaHooks = Readonly<{
  prepare: (
    capability: Readonly<{
      addVideoTrack: (description: Video) => Track
      createDataChannel: (label: string) => DataChannel
    }>,
  ) => void
  activate: (
    context: Readonly<{ binding: RtcSessionBinding; lifetimeDeadline: number }>,
  ) => void
  stop: () => void
}>

type Options = {
  /** Local ICE bind address from validated runtime config. Default loopback. */
  bindAddress?: string
  /** Earlier owner deadlines only; absolute performance.now() milliseconds. */
  authDeadline?: number | undefined
  lifetimeDeadline?: number
  genuineStatus?: GenuineStatusOptions
  onVerifiedAdmission?: (admission: VerifiedRtcAdmission) => void
  onVerified?: () => void
  onTerminal?: (reason: string) => void
  fixtureOnlyMedia?: FixtureOnlyMediaHooks
  /** Opt-in camera media (see camera/camera-media.ts); exclusive with fixture media. */
  cameraMedia?: FixtureOnlyMediaHooks
  identity: ConnectorIdentity
  /** Trusted enrollment/runtime configuration, never the RTC binding's agent_id. */
  expectedAgentId: string
  /** One-shot authenticated-signalling context, never a received RTC proof. */
  admittedBinding: Promise<unknown>
}
const noop = () => {}
/** Keep a single status frame bounded while allowing short network stalls. */
export const READONLY_PENDING_BYTES = 1_048_576
/** A read-only peer falls back to display-only when congestion persists. */
export const READONLY_BACKPRESSURE_TIMEOUT_MS = 5_000
/** Native queue depth that resumes status delivery after backpressure. */
export const READONLY_STATUS_LOW_WATER_BYTES = 0

/** Native application channel port used by the status queue.
 * A refused write is backpressure, not a failure. */
export type StatusChannelPort = Readonly<{
  sendMessage(wire: string): boolean
  bufferedAmount(): number
  isOpen(): boolean
  onBufferedAmountLow(callback: () => void): void
}>

/** Result of one native status write. */
export type StatusWrite = 'sent' | 'coalesced' | 'rejected'

/** Bounded native status queue for a read-only peer.
 *
 * A refused native write means the bytes are queued natively, not a failure:
 * the read-only session survives, the newest frame wins over the older ones
 * and the frame is delivered once the native channel drains. The #173 bound
 * closes the peer only when the congestion outlives its timeout. */
export class ReadonlyStatusQueue<TFrame> {
  #channel: StatusChannelPort
  #write: (frame: TFrame) => boolean
  #onTerminal: (reason: string) => void
  #pendingBytes: number
  #timeoutMs: number
  #pending: TFrame | undefined
  #congested = false
  #accepted = false
  #terminal: string | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  constructor(options: {
    channel: StatusChannelPort
    /** Writes one frame through the session; the adapter calls `sendWire`. */
    write: (frame: TFrame) => boolean
    /** Congestion outlived the #173 timeout, or the channel is unusable. */
    onTerminal: (reason: string) => void
    pendingBytes?: number
    timeoutMs?: number
  }) {
    this.#channel = options.channel
    this.#write = options.write
    this.#onTerminal = options.onTerminal
    this.#pendingBytes = options.pendingBytes ?? READONLY_PENDING_BYTES
    this.#timeoutMs = options.timeoutMs ?? READONLY_BACKPRESSURE_TIMEOUT_MS
    this.#channel.onBufferedAmountLow(() => this.#drain())
  }
  /** Native queue depth in bytes. */
  bufferedAmount() {
    const buffered = this.#channel.bufferedAmount()
    if (!Number.isSafeInteger(buffered) || buffered < 0) {
      this.#fail('status-buffer-invalid')
      return 0
    }
    if (buffered > this.#pendingBytes) this.#congest()
    return buffered
  }
  /** Native write performed by the session adapter.
   * 'coalesced' means the frame stays queued until the channel drains. */
  sendWire(wire: string): StatusWrite {
    this.#accepted = false
    if (this.#terminal) return 'rejected'
    if (!this.#channel.isOpen()) {
      this.#fail('status-channel-closed')
      return 'rejected'
    }
    const size = new TextEncoder().encode(wire).byteLength
    if (size > this.#pendingBytes) return 'rejected'
    const buffered = this.bufferedAmount()
    if (this.#terminal) return 'rejected'
    if (buffered + size > this.#pendingBytes) {
      this.#congest()
      return 'coalesced'
    }
    if (!this.#channel.sendMessage(wire)) {
      // Native SCTP backpressure: the bytes are queued natively, not lost.
      this.#congest()
      return 'coalesced'
    }
    this.#accepted = true
    return 'sent'
  }
  /** Offer one frame. True when the transport took it. */
  offer(frame: TFrame): boolean {
    this.#accepted = false
    if (this.#terminal) return false
    this.#refresh()
    if (this.#congested) {
      // Coalesce: the newest frame replaces the held one.
      this.#pending = frame
      return false
    }
    if (!this.#write(frame)) return false
    if (!this.#accepted) {
      // The native channel refused the frame: keep it for the next drain.
      this.#pending = frame
      this.#congest()
      return false
    }
    return true
  }
  /** A coalesced frame waiting for the native drain. */
  pending() {
    return this.#pending !== undefined
  }
  close() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#terminal = this.#terminal ?? 'closed'
    this.#pending = undefined
  }
  /** Observe the native queue; resumes delivery once it drains. */
  #refresh() {
    if (this.#terminal || !this.#congested) return
    const buffered = this.bufferedAmount()
    if (this.#terminal) return
    if (buffered > READONLY_STATUS_LOW_WATER_BYTES) return
    this.#congested = false
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#flush()
  }
  #drain() {
    this.#refresh()
  }
  #flush() {
    const frame = this.#pending
    if (frame === undefined) return
    this.#pending = undefined
    if (!this.#write(frame)) return
    if (!this.#accepted) {
      // Still congested: keep the frame until the next drain.
      this.#pending = frame
      this.#congest()
    }
  }
  #congest() {
    this.#congested = true
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#fail('status-backpressure')
    }, this.#timeoutMs)
  }
  #fail(reason: string) {
    if (this.#terminal) return
    this.#terminal = reason
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending = undefined
    this.#onTerminal(reason)
  }
}

/** Coalesced status frame held until the native channel drains. */
type PendingStatus =
  | { readonly kind: 'genuine'; readonly input: unknown }
  | { readonly kind: 'fixture' }
/** Detached read-only prototype. No enrollment, authorization, media or commands. */
export class ReadonlyConnectorPeer {
  #peer: PeerConnection
  #proof: DataChannel
  #application: DataChannel
  #status: ReadonlyStatusQueue<PendingStatus>
  #inbox: RtcProofInbox
  #binding: Promise<RtcSessionBinding>
  #closed: Promise<void>
  #resolveClosed: () => void = () => {}
  #options: Readonly<Options>
  #effective: EffectiveRtcDescriptions | undefined
  #admitted: RtcSessionBinding | undefined
  #session: ReadonlyRtcSession | undefined
  #terminal: string | undefined
  #offerStarted = false
  #offer: string | undefined
  #answer: string | undefined
  #mediaTrackAdded = false
  #mediaChannelAdded = false
  #media: FixtureOnlyMediaHooks | undefined
  #opened = false
  #starting = false
  #stage = 'constructed'
  #closeCount = 0
  #certificateMatched = false
  #sentProofs = 0
  #receivedProofs = 0
  #actualRemote: string | undefined
  #gathered: Promise<void>
  #resolveGathered: () => void = noop
  #authDeadline = performance.now() + 8000
  #lifetimeDeadline = performance.now() + 30000
  #authTimer: ReturnType<typeof setTimeout>
  #lifetimeTimer: ReturnType<typeof setTimeout>
  constructor(options: Options) {
    BrowserDeviceUuid.parse(options.expectedAgentId)
    if (options.fixtureOnlyMedia && options.cameraMedia)
      throw Error('Exclusive media hooks')
    const now = performance.now()
    for (const cap of [options.authDeadline, options.lifetimeDeadline])
      if (cap !== undefined && (!Number.isFinite(cap) || cap <= now))
        throw Error('Expired owner deadline')
    this.#authDeadline = Math.min(
      this.#authDeadline,
      options.authDeadline ?? Infinity,
    )
    this.#lifetimeDeadline = Math.min(
      this.#lifetimeDeadline,
      options.lifetimeDeadline ?? Infinity,
    )

    this.#options = Object.freeze({
      ...options,
      ...(options.genuineStatus
        ? {
            genuineStatus: Object.freeze({
              ...options.genuineStatus,
              assignmentRefs: snapshotAssignmentRefs(
                options.genuineStatus.assignmentRefs,
                options.expectedAgentId,
              ),
            }),
          }
        : {}),
    })
    const media = options.cameraMedia ?? options.fixtureOnlyMedia
    this.#media = media && {
      prepare: media.prepare.bind(media),
      activate: media.activate.bind(media),
      stop: media.stop.bind(media),
    }
    this.#peer = new PeerConnection('readonly-connector', {
      iceServers: [],
      bindAddress: rtcBindAddress(options.bindAddress),
      enableIceTcp: false,
      disableAutoNegotiation: true,
      disableFingerprintVerification: false,
      maxMessageSize: MAX_RTC_PROOF_WIRE_BYTES,
    })
    this.#proof = this.#peer.createDataChannel('readonly-proof-v1', {
      unordered: false,
    })
    this.#application = this.#peer.createDataChannel(
      'readonly-fixture-status-v1',
      { unordered: false },
    )
    this.#status = new ReadonlyStatusQueue<PendingStatus>({
      channel: this.#application,
      write: (frame) =>
        frame.kind === 'genuine'
          ? (this.#session?.sendGenuineStatus(frame.input) ?? false)
          : (this.#session?.sendStatus() ?? false),
      onTerminal: (reason) => this.close(reason),
    })
    this.#application.setBufferedAmountLowThreshold(
      READONLY_STATUS_LOW_WATER_BYTES,
    )
    this.#inbox = new RtcProofInbox({
      paused: true,
      inspect: async (proof) => {
        this.#receivedProofs = Math.min(1024, this.#receivedProofs + 1)
        if (!this.#session || this.#terminal) {
          this.close('session-unavailable')
          return
        }
        await this.#session.inspectProof(proof)
      },
      onReadonly: () => this.close('proof-inbox'),
    })
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    const weak = new WeakRef(this)
    this.#binding = options.admittedBinding.then((input) => {
      const owner = weak.deref()
      if (!owner?.current()) throw Error('Terminal admission')
      const binding = RtcSessionBinding.parse(input)
      Object.freeze(binding.browser_public_key)
      Object.freeze(binding)
      if (binding.agent_id !== owner.#options.expectedAgentId)
        throw Error('Wrong admitted agent')
      return binding
    })
    void this.#binding.catch(() => weak.deref()?.close('admission-rejected'))
    this.#gathered = new Promise((resolve) => {
      this.#resolveGathered = resolve
    })
    this.#authTimer = setTimeout(
      () => this.close('auth-deadline'),
      Math.max(0, this.#authDeadline - performance.now()),
    )
    this.#lifetimeTimer = setTimeout(
      () => this.close('prototype-lifetime'),
      Math.max(0, this.#lifetimeDeadline - performance.now()),
    )
    this.#peer.onGatheringStateChange((state) => {
      if (state === 'complete') this.#resolveGathered()
    })
    this.#peer.onStateChange((state) => {
      if (['closed', 'failed', 'disconnected'].includes(state))
        this.close('transport-' + state)
    })
    this.#proof.onOpen(() => {
      if (this.#terminal) return
      this.#opened = true
      this.start()
    })
    this.#proof.onMessage((raw) => {
      if (!this.#terminal) void this.#inbox.receive(raw)
    })
    this.#proof.onClosed(() => this.close('proof-closed'))
    this.#proof.onError(() => this.close('proof-error'))
    this.#application.onMessage((raw) => {
      if (this.#terminal) return
      try {
        boundRtcApplicationFrame(raw)
      } catch {
        this.close('application-frame')
        return
      }
      if (!this.#session) {
        this.close('application-before-proof')
        return
      }
      this.#session.receiveApplication(raw)
    })
    this.#application.onClosed(() => this.close('application-closed'))
    this.#application.onError(() => this.close('application-error'))
    let preparingFixture = true
    try {
      this.#media?.prepare(
        Object.freeze({
          addVideoTrack: (description: Video) => {
            if (
              !preparingFixture ||
              this.#terminal ||
              this.#offerStarted ||
              this.#mediaTrackAdded
            )
              throw Error('Fixture track reservation closed')
            this.#mediaTrackAdded = true
            return this.#peer.addTrack(description)
          },
          createDataChannel: (label: string) => {
            if (
              !preparingFixture ||
              this.#terminal ||
              this.#offerStarted ||
              this.#mediaChannelAdded ||
              label === 'readonly-proof-v1' ||
              label === 'readonly-fixture-status-v1'
            )
              throw Error('Fixture channel reservation closed')
            this.#mediaChannelAdded = true
            return this.#peer.createDataChannel(label, { unordered: false })
          },
        }),
      )
    } catch (error) {
      this.close('fixture-media-prepare')
      throw error
    } finally {
      preparingFixture = false
    }
  }
  private current() {
    if (this.#terminal) return false
    if (
      performance.now() >= this.#lifetimeDeadline ||
      ((!this.#session || this.#session.snapshot().state === 'pending') &&
        performance.now() >= this.#authDeadline)
    ) {
      this.close('deadline')
      return false
    }
    if (this.#effective) {
      try {
        const current = captureEffectiveRtcDescriptions(
          this.#peer.localDescription(),
          this.#peer.remoteDescription(),
        )
        if (this.#admitted)
          checkEffectiveRtcDescriptions(
            this.#admitted,
            'connector',
            this.#effective,
            current,
          )
        else if (
          current.local.sdp !== this.#effective.local.sdp ||
          current.remote.sdp !== this.#effective.remote.sdp ||
          current.local.type !== this.#effective.local.type ||
          current.remote.type !== this.#effective.remote.type
        )
          throw Error('Description replaced')
      } catch {
        this.close('effective-description-changed')
        return false
      }
    }
    return true
  }
  async offer() {
    if (!this.current() || this.#offerStarted) throw Error('Offer unavailable')
    this.#offerStarted = true
    try {
      this.#peer.setLocalDescription('offer')
      await this.#gathered
      if (!this.current()) throw Error('Offer expired')
      const local = this.#peer.localDescription()
      if (!local) throw Error('Missing offer')
      this.#offer = local.sdp
      return this.#offer
    } catch (error) {
      this.close('offer-failed')
      throw error
    }
  }
  answer(sdp: string) {
    if (!this.current() || !this.#offer || this.#answer) {
      this.close('description-replacement')
      throw Error('Answer unavailable')
    }
    try {
      rtcDtlsFingerprint(sdp)
      this.#peer.setRemoteDescription(sdp, 'answer')
      const remote = this.#peer.remoteDescription()
      if (!remote) throw Error('Remote SDP missing')
      this.#effective = captureEffectiveRtcDescriptions(
        this.#peer.localDescription(),
        remote,
      )
      this.#answer = sdp
      this.start()
    } catch (error) {
      this.close('answer-failed')
      throw error
    }
  }
  private start() {
    if (
      !this.current() ||
      !this.#opened ||
      !this.#offer ||
      !this.#answer ||
      this.#starting
    )
      return
    this.#starting = true
    void this.activate(this.#offer, this.#answer).catch(() =>
      this.close('binding-or-certificate'),
    )
  }
  private async activate(local: string, remote: string) {
    this.#stage = 'await-admission'
    const binding = await Promise.race([
      this.#binding,
      this.#closed.then(() => undefined),
    ])
    if (!binding) return
    if (!this.current()) return
    this.#stage = 'validate-wire-descriptions'
    const validated = await rtcBindingFromDescriptions(
      binding,
      'connector',
      local,
      remote,
    )
    this.#stage = 'check-effective-descriptions'
    this.#admitted = validated
    if (!this.current()) return
    this.#stage = 'actual-certificate'
    const actual = this.#peer.remoteFingerprint()
    this.#actualRemote = actual.value.toUpperCase()
    if (
      actual.algorithm !== 'sha-256' ||
      this.#actualRemote !== rtcDtlsFingerprint(remote)
    )
      throw Error('Actual certificate mismatch')
    this.#certificateMatched = true
    this.#stage = 'role-proofs'
    this.#session = new ReadonlyRtcSession({
      binding: validated,
      role: 'connector',
      ...(this.#options.genuineStatus
        ? { genuineStatus: this.#options.genuineStatus }
        : {}),
      authDeadline: this.#authDeadline,
      lifetimeDeadline: this.#lifetimeDeadline,
      signProof: (context) =>
        this.#options.identity.signRtcSessionProof({
          binding: context,
          expectedAgentId: this.#options.expectedAgentId,
        }),
      sendProof: (wire) => {
        if (!this.current() || !this.#proof.sendMessage(wire))
          throw Error('Proof send failed')
        this.#sentProofs++
      },
      sendApplication: (wire) => {
        if (!this.current()) throw Error('Status send failed')
        // A refused native write is backpressure, not a failure: the frame
        // stays queued until the channel drains and the session survives.
        if (this.#status.sendWire(wire) === 'rejected')
          throw Error('Status send failed')
      },
      onVerified: () => {
        clearTimeout(this.#authTimer)
        if (this.current())
          runSynchronous(() =>
            this.#options.onVerifiedAdmission?.(
              immutableAdmission(
                validated,
                Math.min(
                  this.#lifetimeDeadline,
                  performance.now() + validated.expires_at - Date.now(),
                ),
              ),
            ),
          )
        if (this.current()) this.#options.onVerified?.()
        if (this.#media && this.current())
          this.#media.activate(
            Object.freeze({
              binding: validated,
              lifetimeDeadline: this.#lifetimeDeadline,
            }),
          )
      },
      onReadonly: () => this.close('session-readonly'),
    })
    if (!this.current()) {
      this.#session.close()
      return
    }
    this.#inbox.activate()
    await this.#session.start()
    if (this.#session.snapshot().state === 'verified')
      clearTimeout(this.#authTimer)
  }
  sendStatus(input: unknown) {
    return (
      this.current() &&
      this.#application.isOpen() &&
      this.#status.offer({ kind: 'genuine', input })
    )
  }
  sendFixtureStatus() {
    return this.#application.isOpen() && this.#status.offer({ kind: 'fixture' })
  }
  /** Current native queue size for the Connector's coalescing status sender. */
  bufferedStatusAmount() {
    return this.#status.bufferedAmount()
  }
  close(reason = 'closed') {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#resolveClosed()
    try {
      this.#media?.stop()
    } catch {
      this.#stage = 'fixture-media-stop-failed'
    }
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifetimeTimer)
    this.#status.close()
    this.#inbox.close(reason)
    this.#session?.close(reason)
    this.#proof.onMessage(noop)
    this.#application.onMessage(noop)
    this.#resolveGathered()
    this.#closeCount++
    try {
      this.#proof.close()
      this.#application.close()
    } finally {
      try {
        this.#peer.close()
      } finally {
        this.notifyTerminal()
      }
    }
  }
  private notifyTerminal() {
    try {
      this.#options.onTerminal?.(this.#terminal ?? 'closed')
    } catch {
      this.#stage = 'terminal-notification-failed'
    }
  }
  /** Historical nonsecret observations; no authority or transport handle. */
  diagnostics() {
    return Object.freeze({
      certificateMatched: this.#certificateMatched,
      sentProofs: Math.min(1024, this.#sentProofs),
      receivedProofs: Math.min(1024, this.#receivedProofs),
      terminal: this.#terminal !== undefined,
      readOnly: true as const,
    })
  }
  snapshot() {
    return {
      ...(this.#session?.snapshot() ?? {
        state: this.#terminal ? 'readonly' : 'pending',
        accepted: [],
        commands_enabled: false,
      }),
      stage: this.#stage,
      terminal: this.#terminal,
      connection: this.#peer.state(),
      closeCount: this.#closeCount,
      proofWork: this.#inbox.snapshot().work,
      sentProofs: this.#sentProofs,
      receivedProofs: this.#receivedProofs,
      actualRemoteFingerprint: this.#actualRemote,
      expectedRemoteFingerprint: this.#answer
        ? rtcDtlsFingerprint(this.#answer)
        : undefined,
    }
  }
}
