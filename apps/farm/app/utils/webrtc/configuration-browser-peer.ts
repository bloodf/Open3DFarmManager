import {
  ConfigurationSessionBinding,
  configurationBindingFromDescriptions,
  configurationBindingHash,
  decodeConfigurationSessionProof,
  encodeConfigurationSessionProof,
  signConfigurationSessionProof,
  validateConfigurationSessionBinding,
  verifyConfigurationSessionPair,
} from '../../../../../packages/farm-protocol/src/configuration-binding.ts'
import {
  configurationFresh,
  requireP256Private,
} from '../../../../../packages/farm-protocol/src/configuration-common.ts'
import { controlDtlsFingerprint } from '../../../../../packages/farm-protocol/src/control-session-binding.ts'
import { decodeBase64url } from '../../../../../packages/farm-protocol/src/encoding.ts'
import {
  CONFIGURATION_CHANNEL_LABEL,
  MAX_CONFIGURATION_CHANNEL_BYTES,
  decodeConnectorChannelMessage,
  encodeBrowserChannelMessage,
  type BrowserChannelMessage,
  type ConnectorChannelMessage,
} from '../../../../../packages/connector/src/webrtc/configuration-channel.ts'
import {
  captureEffectiveRtcDescriptions,
  type EffectiveRtcDescriptions,
} from '../../../../../packages/connector/src/webrtc/rtc-descriptions.ts'
import { pauseBrowserCertificate } from './pause-control-peer.ts'

const PENDING_BYTES = 4 * MAX_CONFIGURATION_CHANNEL_BYTES

export type ConfigurationExpectedPeerContext = Readonly<{
  transportId: string
  farmId: string
  agentId: string
  accountId: string
  keyId: string
  browserThumbprint: string
  connectorFingerprint: string
  origin: string
  audience: string
}>

export type ConfigurationProofsReady = Readonly<{
  binding: ConfigurationSessionBinding
  bindingHash: string
  browserProofWire: string
  connectorProofWire: string
  connectorPublicKey: CryptoKey
  expiresAt: number
  deadlineMonoMs: number
}>

export type ConfigurationBrowserPeerOptions = Readonly<{
  privateKey: CryptoKey
  expected: ConfigurationExpectedPeerContext
  expectedBinding: Promise<unknown>
  authDeadline?: number
  lifetimeDeadline?: number
  clock?: () => number
  onProofsReady?: (value: ConfigurationProofsReady) => void
  onMessage?: (
    message: Readonly<
      Extract<ConnectorChannelMessage, { t: 'response' | 'inventory-result' }>
    >,
  ) => void
  onTerminal?: (reason: string) => void
}>

function configurationOnlySdp(sdp: string): void {
  controlDtlsFingerprint(sdp)
  if ((sdp.match(/^m=/gm)?.length ?? 0) !== 1 || !/^m=application /m.test(sdp))
    throw new Error('Configuration data-channel-only SDP required')
  if (/ typ relay/.test(sdp)) throw new Error('Relay candidates refused')
}

function assertExpectedBinding(
  binding: ConfigurationSessionBinding,
  expected: ConfigurationExpectedPeerContext,
): void {
  if (
    binding.transport_id !== expected.transportId ||
    binding.farm_id !== expected.farmId ||
    binding.agent_id !== expected.agentId ||
    binding.account_id !== expected.accountId ||
    binding.key_id !== expected.keyId ||
    binding.browser_thumbprint !== expected.browserThumbprint ||
    binding.connector_fingerprint !== expected.connectorFingerprint ||
    binding.origin !== expected.origin ||
    binding.audience !== expected.audience
  )
    throw new Error('Configuration binding context mismatch')
}

/**
 * Dedicated browser config-v1 WebRTC peer. Answers with full ICE gathering,
 * pins DTLS certificate and SDP hashes, and exchanges domain-separated proofs
 * on the ordered configuration-v1 data channel before any request or
 * inventory message is allowed.
 */
export class ConfigurationBrowserPeer {
  readonly closed: Promise<void>
  #resolveClosed: () => void = () => {}
  #peer: RTCPeerConnection | undefined
  #channel: RTCDataChannel | undefined
  #options: ConfigurationBrowserPeerOptions
  #clock: () => number
  #expected: Promise<ConfigurationSessionBinding | undefined>
  #binding: ConfigurationSessionBinding | undefined
  #bindingHash: string | undefined
  #effective: EffectiveRtcDescriptions | undefined
  #ownProof:
    | {
        v: 1
        role: 'browser'
        binding: ConfigurationSessionBinding
        signature: string
      }
    | undefined
  #ownProofWire: string | undefined
  #earlyConnectorProof: string | undefined
  #authenticated = false
  #terminal: string | undefined
  #answerStarted = false
  #answerWork: Promise<string> | undefined
  #offer: string | undefined
  #answer: string | undefined
  #starting = false
  #certificateMatched = false
  #closeCount = 0
  #cleanupFailures = 0
  #resolveGathered: () => void = () => {}
  #terminated: Promise<void>
  #resolveTerminated: () => void = () => {}
  #authDeadline: number
  #lifetimeDeadline: number
  #authTimer: ReturnType<typeof setTimeout>
  #lifetimeTimer: ReturnType<typeof setTimeout>

  constructor(input: ConfigurationBrowserPeerOptions) {
    requireP256Private(input.privateKey, 'configuration')
    const nowMono = performance.now()
    for (const cap of [input.authDeadline, input.lifetimeDeadline])
      if (cap !== undefined && (!Number.isFinite(cap) || cap <= nowMono))
        throw new Error('Expired configuration peer deadline')
    this.#authDeadline = Math.min(
      nowMono + 10_000,
      input.authDeadline ?? Infinity,
    )
    this.#lifetimeDeadline = Math.min(
      nowMono + 30_000,
      input.lifetimeDeadline ?? Infinity,
    )
    this.#clock = input.clock ?? Date.now
    this.#options = Object.freeze({
      ...input,
      expected: Object.freeze({ ...input.expected }),
    })
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#terminated = new Promise((resolve) => {
      this.#resolveTerminated = resolve
    })
    this.#authTimer = setTimeout(
      () => this.close('auth-deadline'),
      Math.max(0, this.#authDeadline - performance.now()),
    )
    this.#lifetimeTimer = setTimeout(
      () => this.close('lifetime-deadline'),
      Math.max(0, this.#lifetimeDeadline - performance.now()),
    )
    const weak = new WeakRef(this)
    this.#expected = Promise.resolve(input.expectedBinding)
      .then(async (value) => {
        const owner = weak.deref()
        if (!owner?.current()) return undefined
        const binding = await validateConfigurationSessionBinding(value)
        if (!owner.current()) return undefined
        assertExpectedBinding(binding, owner.#options.expected)
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
          channel.label !== CONFIGURATION_CHANNEL_LABEL ||
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
          if (this.current()) this.receive(message.data)
        }
        channel.onclose = () => this.close('channel-closed')
        channel.onerror = () => this.close('channel-error')
        channel.onopen = () => this.start()
        if (channel.readyState === 'open') this.start()
      }
      this.#peer.onsignalingstatechange = () => {
        if (
          this.#answer &&
          this.#peer &&
          this.#peer.signalingState !== 'stable'
        )
          this.close('signalling-replacement')
      }
      this.#peer.onnegotiationneeded = () => {
        if (this.#answer) this.close('renegotiation-forbidden')
      }
    } catch (error) {
      this.close('construction-failed')
      throw error
    }
  }

  private current(): boolean {
    if (this.#terminal) return false
    const now = performance.now()
    if (
      now >= this.#lifetimeDeadline ||
      (!this.#authenticated && now >= this.#authDeadline)
    ) {
      this.close('deadline')
      return false
    }
    if (this.#effective && this.#peer) {
      try {
        const current = captureEffectiveRtcDescriptions(
          this.#peer.localDescription,
          this.#peer.remoteDescription,
        )
        if (
          current.local.type !== 'answer' ||
          current.remote.type !== 'offer' ||
          current.local.sdp !== this.#effective.local.sdp ||
          current.remote.sdp !== this.#effective.remote.sdp
        )
          throw new Error('Description changed')
      } catch {
        this.close('description-changed')
        return false
      }
    }
    return true
  }

  answer(offer: string): Promise<string> {
    if (this.#answerWork) {
      this.close('answer-state')
      return Promise.reject(new Error('Configuration answer unavailable'))
    }
    this.#answerWork = this.createAnswer(offer)
    return this.#answerWork
  }

  private async createAnswer(offer: string): Promise<string> {
    if (!this.current() || this.#answerStarted || !this.#peer) {
      this.close('answer-state')
      throw new Error('Configuration answer unavailable')
    }
    this.#answerStarted = true
    try {
      configurationOnlySdp(offer)
      this.#offer = offer
      await this.#peer.setRemoteDescription({ type: 'offer', sdp: offer })
      if (!this.current()) throw new Error('Configuration answer expired')
      const answer = await this.#peer.createAnswer()
      if (!this.current()) throw new Error('Configuration answer expired')
      await this.#peer.setLocalDescription(answer)
      if (!this.current()) throw new Error('Configuration answer expired')
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
      if (!this.current()) throw new Error('Configuration answer expired')
      const local = this.#peer.localDescription
      if (!local) throw new Error('Configuration answer missing')
      configurationOnlySdp(local.sdp)
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
    void this.activate(this.#answer, this.#offer).catch(() =>
      this.close('certificate-or-binding'),
    )
  }

  private async activate(localSdp: string, remoteSdp: string): Promise<void> {
    const expected = await Promise.race([
      this.#expected,
      this.#terminated.then(() => undefined),
    ])
    if (!expected || !this.current()) return
    const binding = await configurationBindingFromDescriptions(
      expected,
      'browser',
      localSdp,
      remoteSdp,
    )
    if (!this.current() || !this.#peer) return
    const stats = await this.#peer.getStats()
    if (!this.current()) return
    if (!pauseBrowserCertificate(stats, binding.connector_dtls))
      throw new Error('Actual configuration certificate mismatch')
    this.#certificateMatched = true
    const signature = await signConfigurationSessionProof(
      binding,
      'browser',
      this.#options.privateKey,
    )
    if (!this.current()) return
    const ownProof = {
      v: 1 as const,
      role: 'browser' as const,
      binding,
      signature,
    }
    const ownProofWire = encodeConfigurationSessionProof(ownProof)
    this.#binding = binding
    this.#bindingHash = await configurationBindingHash(binding)
    this.#ownProof = ownProof
    this.#ownProofWire = ownProofWire
    this.sendWire(
      encodeBrowserChannelMessage({
        v: 1,
        t: 'proof',
        proof: ownProofWire,
      }),
    )
    const early = this.#earlyConnectorProof
    this.#earlyConnectorProof = undefined
    if (early !== undefined) await this.acceptConnectorProof(early)
  }

  private receive(raw: unknown): void {
    if (!this.current()) return
    let message: ConnectorChannelMessage
    try {
      message = decodeConnectorChannelMessage(raw)
    } catch {
      this.close('protocol-violation')
      return
    }
    if (message.t === 'proof') {
      if (this.#authenticated) {
        this.close('protocol-violation')
        return
      }
      if (!this.#ownProof) {
        if (this.#earlyConnectorProof !== undefined) {
          this.close('protocol-violation')
          return
        }
        this.#earlyConnectorProof = message.proof
        return
      }
      void this.acceptConnectorProof(message.proof).catch(() =>
        this.close('proof-rejected'),
      )
      return
    }
    if (!this.#authenticated) {
      this.close('protocol-violation')
      return
    }
    try {
      this.#options.onMessage?.(Object.freeze(structuredClone(message)))
    } catch {
      this.close('message-callback-failed')
    }
  }

  private async acceptConnectorProof(wire: string): Promise<void> {
    if (
      !this.current() ||
      this.#authenticated ||
      !this.#ownProof ||
      !this.#ownProofWire ||
      !this.#binding ||
      !this.#bindingHash ||
      !this.#answer ||
      !this.#offer
    ) {
      this.close('proof-rejected')
      return
    }
    const connectorProof = decodeConfigurationSessionProof(wire)
    if (connectorProof.role !== 'connector') {
      this.close('proof-rejected')
      return
    }
    const verified = await verifyConfigurationSessionPair(
      this.#ownProof,
      connectorProof,
      { role: 'browser', localSdp: this.#answer, remoteSdp: this.#offer },
    )
    const verifiedHash = verified
      ? await configurationBindingHash(verified)
      : undefined
    if (
      !this.current() ||
      !verified ||
      verifiedHash !== this.#bindingHash ||
      !configurationFresh(this.#binding, this.#clock(), 2000)
    ) {
      this.close('proof-rejected')
      return
    }
    const connectorPublicKey = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(
        decodeBase64url(this.#binding.connector_public_key_spki, 44),
      ),
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
    if (!this.current()) return
    this.#authenticated = true
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifetimeTimer)
    const remainingWallMs = Math.max(
      0,
      this.#binding.expires_at - this.#clock(),
    )
    const deadlineMonoMs = Math.min(
      this.#lifetimeDeadline,
      performance.now() + remainingWallMs,
    )
    this.#lifetimeDeadline = deadlineMonoMs
    this.#lifetimeTimer = setTimeout(
      () => this.close('binding-expired'),
      Math.max(0, deadlineMonoMs - performance.now()),
    )
    this.#options.onProofsReady?.(
      Object.freeze({
        binding: this.#binding,
        bindingHash: this.#bindingHash,
        browserProofWire: this.#ownProofWire,
        connectorProofWire: wire,
        connectorPublicKey,
        expiresAt: this.#binding.expires_at,
        deadlineMonoMs,
      }),
    )
  }

  sendMessage(message: BrowserChannelMessage): boolean {
    if (!this.current() || !this.#authenticated || message.t === 'proof') {
      this.close('send-state')
      return false
    }
    try {
      this.sendWire(encodeBrowserChannelMessage(message))
      return true
    } catch {
      this.close('send-failed')
      return false
    }
  }

  private sendWire(wire: string): void {
    const channel = this.#channel
    const size = new TextEncoder().encode(wire).byteLength
    if (
      !this.current() ||
      !channel ||
      channel.readyState !== 'open' ||
      size > MAX_CONFIGURATION_CHANNEL_BYTES ||
      !Number.isSafeInteger(channel.bufferedAmount) ||
      channel.bufferedAmount + size > PENDING_BYTES
    )
      throw new Error('Configuration channel outbound limit')
    channel.send(wire)
  }

  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#closeCount++
    this.#resolveGathered()
    this.#resolveTerminated()
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifetimeTimer)
    this.#earlyConnectorProof = undefined
    const channel = this.#channel
    const peer = this.#peer
    this.#channel = undefined
    this.#peer = undefined
    for (const cleanup of [
      () => {
        if (!channel) return
        channel.onmessage = null
        channel.onclose = null
        channel.onerror = null
        channel.onopen = null
        channel.close()
      },
      () => {
        if (!peer) return
        peer.onconnectionstatechange = null
        peer.ontrack = null
        peer.ondatachannel = null
        peer.onsignalingstatechange = null
        peer.onnegotiationneeded = null
        peer.onicegatheringstatechange = null
        peer.close()
      },
    ]) {
      try {
        cleanup()
      } catch {
        this.#cleanupFailures++
      }
    }
    try {
      this.#options.onTerminal?.(this.#terminal)
    } finally {
      this.#resolveClosed()
    }
  }

  diagnostics() {
    return Object.freeze({
      certificateMatched: this.#certificateMatched,
      authenticated: this.#authenticated,
      terminal: this.#terminal !== undefined,
      terminalReason: this.#terminal ?? null,
      closeCount: this.#closeCount,
      cleanupFailures: this.#cleanupFailures,
    })
  }
}
