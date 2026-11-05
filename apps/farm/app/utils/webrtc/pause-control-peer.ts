import {
  ControlSessionBinding,
  controlBindingFromDescriptions,
  controlDtlsFingerprint,
  validateControlSessionBinding,
} from '../../../../../packages/farm-protocol/src/control-session-binding.ts'
import { MAX_PAUSE_CHANNEL_WIRE_BYTES } from '../../../../../packages/farm-protocol/src/pause-channel.ts'
import {
  captureEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from '../../../../../packages/connector/src/webrtc/rtc-descriptions.ts'
import {
  PauseControlSession,
  PauseExpectedContext,
  PAUSE_PENDING_BYTES,
  pauseSynchronous,
  assertPauseExpected,
  checkPauseEffectiveDescriptions,
  pausePrivateKey,
  type PauseBrowserExpectedContext,
  type PausePhaseFrame,
  type PausePhaseMessage,
  type PauseProofsReady,
} from '../../../../../packages/connector/src/webrtc/pause-control-session.ts'

type Options = Readonly<{
  privateKey: CryptoKey
  expected: PauseBrowserExpectedContext
  expectedBinding: Promise<unknown>
  authDeadline?: number
  lifetimeDeadline?: number
  onProofsReady?: (value: PauseProofsReady) => void
  onPhase?: (frame: Readonly<PausePhaseFrame>) => void
  onTerminal?: (reason: string) => void
}>
function controlOnly(sdp: string) {
  controlDtlsFingerprint(sdp)
  if ((sdp.match(/^m=/gm)?.length ?? 0) !== 1 || !/^m=application /m.test(sdp))
    throw Error('Control-only SDP required')
}
/** Only a single connected DTLS transport and its exact certificate may authenticate this peer. */
export function pauseBrowserCertificate(
  stats: RTCStatsReport,
  expected: string,
): boolean {
  const transports: { remoteCertificateId: string }[] = []
  stats.forEach((report) => {
    if (
      report.type === 'transport' &&
      report.dtlsState === 'connected' &&
      typeof report.remoteCertificateId === 'string'
    )
      transports.push({ remoteCertificateId: report.remoteCertificateId })
  })
  if (transports.length !== 1) return false
  const certificate = stats.get(transports[0]!.remoteCertificateId)
  return (
    certificate?.type === 'certificate' &&
    certificate.fingerprintAlgorithm === 'sha-256' &&
    typeof certificate.fingerprint === 'string' &&
    certificate.fingerprint.toUpperCase() === expected
  )
}
/** Separate browser control peer. No command path, readonly upgrade, or capability verification. */
export class PauseBrowserPeer {
  readonly closed: Promise<void>
  #resolveClosed: () => void = () => {}
  #peer: RTCPeerConnection | undefined
  #channel: RTCDataChannel | undefined
  #session: PauseControlSession
  #options: Options
  #expected: Promise<ControlSessionBinding | undefined>
  #validation: Promise<ControlSessionBinding> | undefined
  #activation: Promise<void> | undefined
  #answerWork: Promise<string> | undefined
  #binding: ControlSessionBinding | undefined
  #effective: EffectiveRtcDescriptions | undefined
  #terminal: string | undefined
  #answerStarted = false
  #offer: string | undefined
  #answer: string | undefined
  #starting = false
  #certificateMatched = false
  #closeCount = 0
  #cleanupFailures = 0
  #resolveGathered: () => void = () => {}
  #terminated: Promise<void>
  #resolveTerminated: () => void = () => {}
  constructor(input: Options) {
    const expected = Object.freeze(PauseExpectedContext.parse(input.expected))
    if (
      expected.accountId === undefined ||
      expected.keyId === undefined ||
      expected.origin === undefined ||
      expected.audience === undefined
    )
      throw Error('Browser control context incomplete')
    pausePrivateKey(input.privateKey)
    this.#options = Object.freeze({
      ...input,
      expected: {
        ...expected,
        accountId: expected.accountId,
        keyId: expected.keyId,
        origin: expected.origin,
        audience: expected.audience,
      },
    })
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#terminated = new Promise((resolve) => {
      this.#resolveTerminated = resolve
    })
    this.#session = new PauseControlSession({
      role: 'browser',
      privateKey: input.privateKey,
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
      onTerminal: (reason) => this.close(reason),
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
      this.#peer = new RTCPeerConnection({ iceServers: [] })
      this.#peer.onconnectionstatechange = () => {
        if (
          this.#peer &&
          ['closed', 'failed', 'disconnected'].includes(
            this.#peer.connectionState,
          )
        )
          this.close('transport-closed')
      }
      this.#peer.ontrack = (event) => {
        try {
          event.track.stop()
        } catch {
          this.#cleanupFailures++
        } finally {
          this.close('unexpected-media')
        }
      }
      this.#peer.ondatachannel = (event) => {
        const channel = event.channel
        if (
          !this.current() ||
          this.#channel ||
          channel.label !== 'pause-control-v1' ||
          channel.protocol !== '' ||
          !channel.ordered ||
          channel.maxPacketLifeTime !== null ||
          channel.maxRetransmits !== null
        ) {
          try {
            channel.close()
          } catch {
            this.#cleanupFailures++
          } finally {
            this.close('unexpected-channel')
          }
          return
        }
        this.#channel = channel
        channel.onmessage = (message) => {
          if (this.current()) this.#session.receive(message.data)
        }
        channel.onclose = () => this.close('channel-closed')
        channel.onerror = () => this.close('channel-error')
        channel.onopen = () => this.start()
        if (channel.readyState === 'open') this.start()
      }
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
          this.#peer.localDescription,
          this.#peer.remoteDescription,
        )
        if (this.#binding)
          checkPauseEffectiveDescriptions(
            this.#binding,
            'browser',
            this.#effective,
            current,
          )
        else if (
          current.local.type !== this.#effective.local.type ||
          current.remote.type !== this.#effective.remote.type ||
          current.local.sdp !== this.#effective.local.sdp ||
          current.remote.sdp !== this.#effective.remote.sdp
        )
          throw Error('Description changed')
      } catch {
        this.close('description-changed')
        return false
      }
    }
    return this.#session.active
  }
  answer(offer: string): Promise<string> {
    if (this.#answerWork) {
      this.close('answer-state')
      return Promise.reject(Error('Control answer unavailable'))
    }
    this.#answerWork = this.createAnswer(offer)
    return this.#answerWork
  }
  private async createAnswer(offer: string): Promise<string> {
    if (!this.current() || this.#answerStarted || !this.#peer) {
      this.close('answer-state')
      throw Error('Control answer unavailable')
    }
    this.#answerStarted = true
    try {
      controlOnly(offer)
      this.#offer = offer
      await this.#peer.setRemoteDescription({ type: 'offer', sdp: offer })
      if (!this.current()) throw Error('Control answer expired')
      const answer = await this.#peer.createAnswer()
      if (!this.current()) throw Error('Control answer expired')
      await this.#peer.setLocalDescription(answer)
      if (!this.current()) throw Error('Control answer expired')
      await new Promise<void>((resolve) => {
        this.#resolveGathered = resolve
        if (!this.#peer || this.#peer.iceGatheringState === 'complete') {
          resolve()
          return
        }
        this.#peer.onicegatheringstatechange = () => {
          if (this.#peer?.iceGatheringState === 'complete') resolve()
        }
      })
      if (!this.current()) throw Error('Control answer expired')
      const local = this.#peer.localDescription
      if (!local) throw Error('Control answer missing')
      controlOnly(local.sdp)
      this.#effective = captureEffectiveRtcDescriptions(
        local,
        this.#peer.remoteDescription,
      )
      this.#answer = local.sdp
      this.start()
      return local.sdp
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
      this.#channel?.readyState !== 'open'
    )
      return
    this.#starting = true
    this.#activation = this.activate(this.#answer, this.#offer).catch(() =>
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
      'browser',
      local,
      remote,
    )
    if (!this.current() || !this.#peer) return
    this.#binding = binding
    if (!this.current()) return
    const stats = await this.#peer.getStats()
    if (!this.current()) return
    if (!pauseBrowserCertificate(stats, binding.connector_dtls))
      throw Error('Actual control certificate mismatch')
    this.#certificateMatched = true
    if (this.current()) await this.#session.activate(binding)
  }
  private sendWire(wire: string): void {
    const channel = this.#channel,
      size = new TextEncoder().encode(wire).byteLength
    if (
      !this.current() ||
      channel?.readyState !== 'open' ||
      size > MAX_PAUSE_CHANNEL_WIRE_BYTES ||
      !Number.isSafeInteger(channel.bufferedAmount) ||
      channel.bufferedAmount < 0 ||
      channel.bufferedAmount + size > PAUSE_PENDING_BYTES
    )
      throw Error('Control outbound unavailable')
    if (!this.current()) throw Error('Control deadline')
    channel.send(wire)
    if (
      !Number.isSafeInteger(channel.bufferedAmount) ||
      channel.bufferedAmount < 0 ||
      channel.bufferedAmount > PAUSE_PENDING_BYTES
    )
      throw Error('Control outbound limit')
  }
  sendPhase(input: PausePhaseMessage): boolean {
    return this.current() && this.#session.sendPhase(input)
  }
  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#closeCount++
    this.#resolveTerminated()
    this.#resolveGathered()
    this.#session.close(this.#terminal)
    for (const cleanup of [
      () => {
        if (this.#channel) {
          this.#channel.onmessage = null
          this.#channel.onopen = null
          this.#channel.onclose = null
          this.#channel.onerror = null
        }
      },
      () => this.#channel?.close(),
      () => {
        if (this.#peer) {
          this.#peer.ondatachannel = null
          this.#peer.ontrack = null
          this.#peer.onconnectionstatechange = null
          this.#peer.onicegatheringstatechange = null
        }
      },
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
      ...(this.#answerWork ? [this.#answerWork] : []),
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
