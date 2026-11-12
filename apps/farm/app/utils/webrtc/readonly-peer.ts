import {
  captureEffectiveRtcDescriptions,
  checkEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from '../../../../../packages/connector/src/webrtc/rtc-descriptions.ts'
import {
  RtcSessionBinding,
  BrowserRtcProof,
  signRtcSessionProof,
  rtcBindingFromDescriptions,
  rtcDtlsFingerprint,
} from '../../../../../packages/farm-protocol/src/rtc-session-binding.ts'
import { BrowserDeviceUuid } from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  ReadonlyRtcSession,
  immutableAdmission,
  runSynchronous,
  snapshotAssignmentRefs,
  type VerifiedRtcAdmission,
  type GenuineStatusOptions,
} from '../../../../../packages/connector/src/webrtc/readonly-session.ts'
import {
  RtcProofInbox,
  boundRtcApplicationFrame,
} from '../../../../../packages/connector/src/webrtc/rtc-proof-inbox.ts'
import {
  CAMERA_CHANNEL_LABEL,
  type BrowserCameraHooks,
} from './camera-media.ts'

export type FixtureOnlyVideoHooks = Readonly<{
  onTrack: (
    event: Readonly<{ track: MediaStreamTrack; receiver: RTCRtpReceiver }>,
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
  genuineStatus?: GenuineStatusOptions
  onVerifiedAdmission?: (admission: VerifiedRtcAdmission) => void
  onVerified?: () => void
  onTerminal?: (reason: string) => void
  fixtureOnlyVideo?: FixtureOnlyVideoHooks
  /** Opt-in camera-purpose V3 media; exclusive with fixture video. */
  cameraMedia?: BrowserCameraHooks
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
  #certificateMatched = false
  #sentProofs = 0
  #receivedProofs = 0
  #actualRemote: string | undefined
  #resolveGathered: () => void = () => {}
  #camera: BrowserCameraHooks | undefined
  #cameraChannel = false
  #authDeadline = performance.now() + 8000
  #lifetimeDeadline = performance.now() + 30000
  #authTimer: ReturnType<typeof setTimeout>
  #lifetimeTimer: ReturnType<typeof setTimeout>
  constructor(options: Options) {
    BrowserDeviceUuid.parse(options.expectedAgentId)
    if (options.fixtureOnlyVideo && options.cameraMedia)
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
    const camera = options.cameraMedia
    this.#camera = camera && {
      onTrack: camera.onTrack.bind(camera),
      onChannel: camera.onChannel.bind(camera),
      activate: camera.activate.bind(camera),
      stop: camera.stop.bind(camera),
    }
    if (this.#camera)
      this.#peer.ontrack = (event) => {
        if (this.#terminal) {
          event.track.stop()
          return
        }
        try {
          this.#camera?.onTrack(
            Object.freeze({
              track: event.track,
              receiver: event.receiver,
              mid: event.transceiver.mid,
            }),
          )
        } catch {
          this.close('camera-track')
        }
      }
    if (this.#options.fixtureOnlyVideo)
      this.#peer.ontrack = (event) => {
        if (this.#terminal) {
          event.track.stop()
          return
        }
        try {
          this.#options.fixtureOnlyVideo?.onTrack(
            Object.freeze({ track: event.track, receiver: event.receiver }),
          )
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
    this.#authTimer = setTimeout(
      () => this.close('auth-deadline'),
      Math.max(0, this.#authDeadline - performance.now()),
    )
    this.#lifetimeTimer = setTimeout(
      () => this.close('prototype-lifetime'),
      Math.max(0, this.#lifetimeDeadline - performance.now()),
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
      } else if (
        channel.label === CAMERA_CHANNEL_LABEL &&
        !this.#cameraChannel
      ) {
        // Camera is optional: its channel never carries status or proofs, so
        // closing or declining it ends only the camera, never the peer.
        this.#cameraChannel = true
        if (this.#camera) this.#camera.onChannel(channel)
        else channel.close()
        return
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
    this.#certificateMatched = true
    this.#stage = 'role-proofs'
    this.#session = new ReadonlyRtcSession({
      binding: validated,
      role: 'browser',
      ...(this.#options.genuineStatus
        ? { genuineStatus: this.#options.genuineStatus }
        : {}),
      authDeadline: this.#authDeadline,
      lifetimeDeadline: this.#lifetimeDeadline,
      signProof: async (context) =>
        BrowserRtcProof.parse({
          v: context.v,
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
        if (this.#options.fixtureOnlyVideo && this.current())
          this.#options.fixtureOnlyVideo.activate(
            Object.freeze({
              binding: validated,
              lifetimeDeadline: this.#lifetimeDeadline,
            }),
          )
        if (this.#camera && this.current())
          this.#camera.activate(
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
    try {
      this.#camera?.stop()
    } catch {
      this.#stage = 'camera-stop-failed'
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
    this.#peer.onnegotiationneeded = null
    this.#peer.onconnectionstatechange = null
    this.#peer.onicegatheringstatechange = null
    this.#resolveGathered()
    this.#closeCount++
    try {
      this.#proof?.close()
    } finally {
      try {
        this.#application?.close()
      } finally {
        try {
          this.#peer.close()
        } finally {
          try {
            this.#options.onTerminal?.(this.#terminal)
          } catch {
            this.#stage = 'terminal-notification-failed'
          }
        }
      }
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
