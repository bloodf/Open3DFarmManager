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
import { ReadonlyRtcSession } from './readonly-session.ts'

/** Explicit local fixture hook only; not a production camera permission API. */
export type FixtureOnlyMediaHooks = Readonly<{
  prepare: (
    capability: Readonly<{ addVideoTrack: (description: Video) => Track }>,
  ) => void
  activate: (
    context: Readonly<{ binding: RtcSessionBinding; lifetimeDeadline: number }>,
  ) => void
  stop: () => void
}>

type Options = {
  /** Earlier owner deadlines only; absolute performance.now() milliseconds. */
  authDeadline?: number | undefined
  lifetimeDeadline?: number
  onVerified?: () => void
  onTerminal?: (reason: string) => void
  fixtureOnlyMedia?: FixtureOnlyMediaHooks
  identity: ConnectorIdentity
  /** Trusted enrollment/runtime configuration, never the RTC binding's agent_id. */
  expectedAgentId: string
  /** One-shot authenticated-signalling context, never a received RTC proof. */
  admittedBinding: Promise<unknown>
}
const noop = () => {}
/** Detached read-only prototype. No enrollment, authorization, media or commands. */
export class ReadonlyConnectorPeer {
  #peer: PeerConnection
  #proof: DataChannel
  #application: DataChannel
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
  #opened = false
  #starting = false
  #stage = 'constructed'
  #closeCount = 0
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
      ...(options.fixtureOnlyMedia
        ? {
            fixtureOnlyMedia: Object.freeze({
              prepare: options.fixtureOnlyMedia.prepare.bind(
                options.fixtureOnlyMedia,
              ),
              activate: options.fixtureOnlyMedia.activate.bind(
                options.fixtureOnlyMedia,
              ),
              stop: options.fixtureOnlyMedia.stop.bind(
                options.fixtureOnlyMedia,
              ),
            }),
          }
        : {}),
    })
    this.#peer = new PeerConnection('readonly-connector', {
      iceServers: [],
      bindAddress: '127.0.0.1',
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
      this.#options.fixtureOnlyMedia?.prepare(
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
    this.#stage = 'role-proofs'
    this.#session = new ReadonlyRtcSession({
      binding: validated,
      role: 'connector',
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
        if (!this.current() || !this.#application.sendMessage(wire))
          throw Error('Status send failed')
      },
      onVerified: () => {
        clearTimeout(this.#authTimer)
        if (this.current()) this.#options.onVerified?.()
        if (this.#options.fixtureOnlyMedia && this.current())
          this.#options.fixtureOnlyMedia.activate(
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
  sendFixtureStatus() {
    return this.#application.isOpen() && (this.#session?.sendStatus() ?? false)
  }
  close(reason = 'closed') {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#resolveClosed()
    try {
      this.#options.fixtureOnlyMedia?.stop()
    } catch {
      this.#stage = 'fixture-media-stop-failed'
    }
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifetimeTimer)
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
