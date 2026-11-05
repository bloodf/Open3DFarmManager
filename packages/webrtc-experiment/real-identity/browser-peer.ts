import {
  captureEffectiveRtcDescriptions,
  checkEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from '../../connector/src/webrtc/rtc-descriptions.ts'
import {
  RtcSessionBinding,
  BrowserRtcProof,
  signRtcSessionProof,
  rtcBindingFromDescriptions,
  rtcDtlsFingerprint,
} from '../../farm-protocol/src/rtc-session-binding.ts'
import { BrowserDeviceUuid } from '../../farm-protocol/src/browser-device-proof.ts'
import { ReadonlyRtcSession } from '../../connector/src/webrtc/readonly-session.ts'
import {
  RtcProofInbox,
  boundRtcApplicationFrame,
} from '../../connector/src/webrtc/rtc-proof-inbox.ts'

export type FixtureOnlyVideoHooks = Readonly<{
  onTrack: (event: RTCTrackEvent) => void
  activate: (
    context: Readonly<{ binding: RtcSessionBinding; lifetimeDeadline: number }>,
  ) => void
  stop: () => void
}>
type Options = {
  fixtureOnlyVideo?: FixtureOnlyVideoHooks
  privateKey: CryptoKey
  expectedAgentId: string
  /** Supplied by trusted signalling/test context, never a peer proof frame. */
  admittedBinding: Promise<unknown>
}
/** Real P256 primitive fixture, not0013 browser-registry enrollment acceptance. */
export class ReadonlyBrowserPeer {
  #peer: RTCPeerConnection
  #proof: RTCDataChannel | undefined
  #application: RTCDataChannel | undefined
  #inbox: RtcProofInbox
  #options: Readonly<Options>
  #binding: Promise<RtcSessionBinding>
  #closed: Promise<void>
  #resolveClosed: () => void = () => {}
  #effective: EffectiveRtcDescriptions | undefined
  #admitted: RtcSessionBinding | undefined
  #session: ReadonlyRtcSession | undefined
  #terminal: string | undefined
  #offer: string | undefined
  #answer: string | undefined
  #starting = false
  #stage = 'constructed'
  #closeCount = 0
  #sentProofs = 0
  #receivedProofs = 0
  #actualRemote: string | undefined
  #resolveGathered: () => void = () => {}
  #authDeadline = performance.now() + 8000
  #lifetimeDeadline = performance.now() + 30000
  #authTimer: ReturnType<typeof setTimeout>
  #lifetimeTimer: ReturnType<typeof setTimeout>
  constructor(options: Options) {
    BrowserDeviceUuid.parse(options.expectedAgentId)
    this.#options = Object.freeze({
      ...options,
      ...(options.fixtureOnlyVideo
        ? {
            fixtureOnlyVideo: Object.freeze({
              onTrack: options.fixtureOnlyVideo.onTrack.bind(
                options.fixtureOnlyVideo,
              ),
              activate: options.fixtureOnlyVideo.activate.bind(
                options.fixtureOnlyVideo,
              ),
              stop: options.fixtureOnlyVideo.stop.bind(
                options.fixtureOnlyVideo,
              ),
            }),
          }
        : {}),
    })
    this.#peer = new RTCPeerConnection({ iceServers: [] })
    if (this.#options.fixtureOnlyVideo)
      this.#peer.ontrack = (event) => {
        if (this.#terminal) {
          event.track.stop()
          return
        }
        try {
          this.#options.fixtureOnlyVideo?.onTrack(event)
        } catch {
          this.close('fixture-video-track')
        }
      }
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
    this.#authTimer = setTimeout(() => this.close('auth-deadline'), 8000)
    this.#lifetimeTimer = setTimeout(
      () => this.close('prototype-lifetime'),
      30000,
    )
    this.#peer.onconnectionstatechange = () => {
      if (
        ['closed', 'failed', 'disconnected'].includes(
          this.#peer.connectionState,
        )
      )
        this.close('transport-' + this.#peer.connectionState)
    }
    this.#peer.ondatachannel = ({ channel }) => {
      if (this.#terminal) {
        channel.close()
        return
      }
      if (channel.label === 'readonly-proof-v1' && !this.#proof) {
        this.#proof = channel
        channel.onmessage = ({ data }) => {
          if (!this.#terminal) void this.#inbox.receive(data)
        }
        channel.onopen = () => this.start()
      } else if (
        channel.label === 'readonly-fixture-status-v1' &&
        !this.#application
      ) {
        this.#application = channel
        channel.onmessage = ({ data }) => {
          if (this.#terminal) return
          try {
            boundRtcApplicationFrame(data)
          } catch {
            this.close('application-frame')
            return
          }
          if (!this.#session) {
            this.close('application-before-proof')
            return
          }
          this.#session.receiveApplication(data)
        }
      } else {
        channel.close()
        this.close('unexpected-channel')
        return
      }
      channel.onclose = () => this.close('channel-closed')
      channel.onerror = () => this.close('channel-error')
    }
    this.#peer.onsignalingstatechange = () => {
      if (this.#answer && this.#peer.signalingState !== 'stable')
        this.close('signalling-replacement')
    }
    this.#peer.onnegotiationneeded = () => {
      if (this.#answer) this.close('renegotiation-forbidden')
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
          this.#peer.localDescription,
          this.#peer.remoteDescription,
        )
        if (this.#admitted)
          checkEffectiveRtcDescriptions(
            this.#admitted,
            'browser',
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
  async answer(offer: string) {
    if (!this.current() || this.#offer) {
      this.close('description-replacement')
      throw Error('Answer unavailable')
    }
    try {
      rtcDtlsFingerprint(offer)
      this.#offer = offer
      await this.#peer.setRemoteDescription({ type: 'offer', sdp: offer })
      if (!this.current()) throw Error('Expired')
      await this.#peer.setLocalDescription(await this.#peer.createAnswer())
      if (!this.current()) throw Error('Expired')
      await new Promise<void>((resolve) => {
        this.#resolveGathered = resolve
        if (this.#peer.iceGatheringState === 'complete') {
          resolve()
          return
        }
        this.#peer.onicegatheringstatechange = () => {
          if (this.#peer.iceGatheringState === 'complete') resolve()
        }
      })
      if (!this.current()) throw Error('Expired')
      const local = this.#peer.localDescription,
        remote = this.#peer.remoteDescription
      if (!local || !remote) throw Error('Description unavailable')
      this.#effective = captureEffectiveRtcDescriptions(local, remote)
      this.#answer = local.sdp
      this.start()
      return this.#answer
    } catch (error) {
      this.close('description-failed')
      throw error
    }
  }
  private start() {
    if (
      !this.current() ||
      !this.#offer ||
      !this.#answer ||
      this.#proof?.readyState !== 'open' ||
      this.#starting
    )
      return
    this.#starting = true
    void this.activate(this.#answer, this.#offer).catch(() =>
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
      'browser',
      local,
      remote,
    )
    this.#stage = 'check-effective-descriptions'
    this.#admitted = validated
    if (!this.current()) return
    this.#stage = 'actual-certificate'
    const stats = await this.#peer.getStats()
    if (!this.current()) return
    let actual: string | undefined
    let remoteCertificateId: string | undefined
    stats.forEach((report) => {
      if (
        report.type === 'transport' &&
        report.dtlsState === 'connected' &&
        typeof report.remoteCertificateId === 'string'
      )
        remoteCertificateId = report.remoteCertificateId
    })
    stats.forEach((report) => {
      if (
        report.id === remoteCertificateId &&
        report.type === 'certificate' &&
        report.fingerprintAlgorithm === 'sha-256' &&
        typeof report.fingerprint === 'string'
      )
        actual = report.fingerprint.toUpperCase()
    })
    this.#actualRemote = actual
    if (!actual || actual !== rtcDtlsFingerprint(remote))
      throw Error('Actual certificate mismatch')
    this.#stage = 'role-proofs'
    this.#session = new ReadonlyRtcSession({
      binding: validated,
      role: 'browser',
      authDeadline: this.#authDeadline,
      lifetimeDeadline: this.#lifetimeDeadline,
      signProof: async (context) =>
        BrowserRtcProof.parse({
          v: 1,
          role: 'browser',
          binding: context,
          signature: await signRtcSessionProof(
            context,
            'browser',
            this.#options.privateKey,
          ),
        }),
      sendProof: (wire) => {
        if (!this.current() || this.#proof?.readyState !== 'open')
          throw Error('Proof closed')
        this.#proof.send(wire)
        this.#sentProofs++
      },
      sendApplication: (wire) => {
        if (!this.current() || this.#application?.readyState !== 'open')
          throw Error('Application closed')
        this.#application.send(wire)
      },
      onVerified: () => {
        clearTimeout(this.#authTimer)
        if (this.#options.fixtureOnlyVideo && this.current())
          this.#options.fixtureOnlyVideo.activate(
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
  }
  sendFixtureStatus() {
    return (
      this.#application?.readyState === 'open' &&
      (this.#session?.sendStatus() ?? false)
    )
  }
  close(reason = 'closed') {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#resolveClosed()
    try {
      this.#options.fixtureOnlyVideo?.stop()
    } catch {
      this.#stage = 'fixture-video-stop-failed'
    }
    this.#peer.ontrack = null
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifetimeTimer)
    this.#inbox.close(reason)
    this.#session?.close(reason)
    if (this.#proof) this.#proof.onmessage = null
    if (this.#application) this.#application.onmessage = null
    this.#peer.onsignalingstatechange = null
    this.#peer.ondatachannel = null
    this.#peer.onsignalingstatechange = () => {
      if (this.#answer && this.#peer.signalingState !== 'stable')
        this.close('signalling-replacement')
    }
    this.#peer.onnegotiationneeded = null
    this.#peer.onconnectionstatechange = null
    this.#peer.onicegatheringstatechange = null
    this.#resolveGathered()
    this.#closeCount++
    this.#proof?.close()
    this.#application?.close()
    this.#peer.close()
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
      connection: this.#peer.connectionState,
      closeCount: this.#closeCount,
      proofWork: this.#inbox.snapshot().work,
      sentProofs: this.#sentProofs,
      receivedProofs: this.#receivedProofs,
      actualRemoteFingerprint: this.#actualRemote,
      expectedRemoteFingerprint: this.#offer
        ? rtcDtlsFingerprint(this.#offer)
        : undefined,
    }
  }
}
