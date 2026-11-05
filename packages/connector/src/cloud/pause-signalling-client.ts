import { createHash, createPublicKey } from 'node:crypto'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../farm-protocol/src/pairing-proof.ts'
import {
  PauseSignallingClientFrame,
  type PauseSignallingServerFrame,
} from '../../../farm-protocol/src/pause-signalling.ts'
import {
  ControlSessionBinding,
  decodeControlProof,
} from '../../../farm-protocol/src/control-session-binding.ts'
import { PauseChannelFrame } from '../../../farm-protocol/src/pause-channel.ts'
import type { CredentialProofChallenge } from '../../../farm-protocol/src/credential-proof.ts'
import { ConnectorIdentity } from '../identity/store.ts'
import { pauseConnectorSocket } from './authenticated-signalling-client.ts'
import {
  PauseSignallingClientChannel,
  type SocketPort,
  type ChannelClock,
} from '../webrtc/signalling-client-channel.ts'
import {
  pauseSynchronous,
  type PauseProofsReady,
  type PausePhaseFrame,
  type PausePhaseMessage,
} from '../webrtc/pause-control-session.ts'
import type { PauseConnectorPeer } from '../webrtc/pause-control-peer.ts'

type Peer = Pick<
  PauseConnectorPeer,
  'offer' | 'answer' | 'close' | 'closed' | 'sendPhase' | 'diagnostics'
>
type PeerOptions = ConstructorParameters<typeof PauseConnectorPeer>[0]
export type PauseConnectorSignallingScope = Readonly<{
  url: string
  origin: string
  audience: string
  /** Independently provisioned credential PoP audience; never inferred from pause frames. */
  credentialAudience: string
  agentId: string
  farmId: string
  assignmentId: string
  jti: string
  token: string
  identity: ConnectorIdentity
  /** Optional independent operator pins, not locally inferred authority. When absent, current server binding owns these fields. */
  accountId?: string
  keyId?: string
}>
type Options = Readonly<{
  onInboxReady?: () => void
  onProofsReady?: (ready: PauseProofsReady) => void
  onPhase?: (frame: Readonly<PausePhaseFrame>) => void
  onTerminal?: (reason: string) => void
  socketFactory?: () => SocketPort | Promise<SocketPort>
  peerFactory?: (input: PeerOptions) => Peer | Promise<Peer>
  clock?: ChannelClock
}>
/** Separate pause transport only. Current server authority and actual RTC proofs
 * are necessary but never confer capability or dispatch permission. */
export class PauseConnectorSignallingClient {
  #scope: PauseConnectorSignallingScope
  #options: Options
  #channel: PauseSignallingClientChannel
  #begin: Extract<PauseSignallingClientFrame, { t: 'pause.connector-begin' }>
  #phase:
    | 'open'
    | 'inbox-challenge'
    | 'inbox-ready'
    | 'context-request'
    | 'context-challenge'
    | 'rtc-ready'
    | 'answer'
    | 'binding'
    | 'active' = 'open'
  #inboxId: string | undefined
  #inboxGeneration = 0
  #inboxNonce: string | undefined
  #contextId: string | undefined
  #contextNonce: string | undefined
  #publicKey: string
  #fingerprint: string
  #thumbprint: string
  #tokenHash: string
  #peer: Peer | undefined
  #ready: PauseProofsReady | undefined
  #serverBinding: ControlSessionBinding | undefined
  #peerSettlement: Promise<void> = Promise.resolve()
  #peerClosures = new Set<Promise<void>>()
  #peerCloseFailed = false
  #retry: ReturnType<typeof setTimeout> | undefined
  #completion: Promise<void> | undefined
  #resolve: () => void = () => {}
  #reject: (error: Error) => void = () => {}
  #resolveBinding: (value: unknown) => void = () => {}
  #binding = new Promise<unknown>((resolve) => {
    this.#resolveBinding = resolve
  })
  #disposal: Promise<void> | undefined
  constructor(scope: PauseConnectorSignallingScope, options: Options = {}) {
    if (!(scope.identity instanceof ConnectorIdentity))
      throw Error('Owned Connector identity required')
    const begin = PauseSignallingClientFrame.parse({
      v: 1,
      t: 'pause.connector-begin',
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      jti: scope.jti,
      token: scope.token,
    })
    if (begin.t !== 'pause.connector-begin')
      throw Error('Pause Connector begin required')
    this.#begin = begin
    const origin = PairingProofOrigin.parse(scope.origin),
      audience = PairingProofAudience.parse(scope.audience),
      credentialAudience = PairingProofAudience.parse(scope.credentialAudience),
      assignmentId = BrowserDeviceUuid.parse(scope.assignmentId)
    const target = new URL(scope.url)
    if (
      target.protocol !== 'wss:' ||
      target.host !== new URL(origin).host ||
      target.pathname !== '/api/signalling/pause-connector' ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw Error('Pause signalling origin mismatch')
    this.#scope = Object.freeze({
      ...scope,
      origin,
      audience,
      credentialAudience,
      assignmentId,
      ...(scope.accountId !== undefined
        ? { accountId: BrowserDeviceTextId.parse(scope.accountId) }
        : {}),
      ...(scope.keyId !== undefined
        ? { keyId: BrowserDeviceUuid.parse(scope.keyId) }
        : {}),
    })
    this.#options = Object.freeze({ ...options })
    this.#publicKey = scope.identity.publicKeySpki
    this.#fingerprint = scope.identity.fingerprint
    const jwk = createPublicKey({
      key: Buffer.from(this.#publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    }).export({ format: 'jwk' })
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string')
      throw Error('Owned Ed25519 public key required')
    this.#thumbprint = createHash('sha256')
      .update(canonicalize({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))
      .digest('base64url')
    this.#tokenHash = createHash('sha256')
      .update(scope.token)
      .digest('base64url')
    this.#channel = new PauseSignallingClientChannel({
      ...(options.clock ? { clock: options.clock } : {}),
      onOpen: () => {
        if (this.#phase !== 'open') throw Error('Unexpected pause open')
        this.#phase = 'inbox-challenge'
        this.#channel.send(this.#begin)
      },
      onFrame: (frame) => this.frame(frame),
      onTerminal: (reason) => {
        clearTimeout(this.#retry)
        this.#ready = undefined
        const peer = this.#peer
        this.#peer = undefined
        if (peer) this.closePeer(peer, reason)
        this.#reject(Error('Pause signalling closed: ' + reason))
        pauseSynchronous(() => this.#options.onTerminal?.(reason))
      },
    })
  }
  start(): Promise<void> {
    if (this.#completion) return this.#completion
    this.#completion = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    void this.#completion.catch(() => {})
    if (!this.#channel.current()) {
      this.#reject(Error('Pause client terminal'))
      return this.#completion
    }
    this.#channel.connect(
      this.#options.socketFactory ??
        (() => pauseConnectorSocket(this.#scope.url)),
    )
    return this.#completion
  }
  private closePeer(peer: Peer, reason: string) {
    try {
      peer.close(reason)
    } catch {
      this.#peerCloseFailed = true
    }
    const settled = Promise.resolve(peer.closed).catch(() => {
      this.#peerCloseFailed = true
    })
    this.#peerClosures.add(settled)
    void settled.finally(() => this.#peerClosures.delete(settled))
  }
  private validateChallenge(c: CredentialProofChallenge, connectionId: string) {
    const s = this.#scope,
      now = this.#channel.wallNow()
    if (
      c.agent_id !== s.agentId ||
      c.farm_id !== s.farmId ||
      c.jti !== s.jti ||
      c.connection_id !== connectionId ||
      c.origin !== s.origin ||
      c.audience !== s.credentialAudience ||
      c.purpose !== 'signalling' ||
      c.public_key_spki !== this.#publicKey ||
      c.fingerprint !== this.#fingerprint ||
      c.thumbprint !== this.#thumbprint ||
      c.token_hash !== this.#tokenHash ||
      now < c.issued_at ||
      now >= c.expires_at
    )
      throw Error('Untrusted pause credential challenge')
  }
  private sign(c: CredentialProofChallenge, connectionId: string) {
    return this.#scope.identity.signCredentialProof({
      challenge: c,
      token: this.#scope.token,
      expectedOrigin: this.#scope.origin,
      expectedAudience: this.#scope.credentialAudience,
      expectedPurpose: 'signalling',
      expectedConnectionId: connectionId,
      now: this.#channel.wallNow(),
    })
  }
  private scopeMatches(frame: {
    transport_id: string
    farm_id: string
    agent_id: string
    assignment_id: string
  }) {
    const s = this.#scope
    if (
      frame.farm_id !== s.farmId ||
      frame.agent_id !== s.agentId ||
      frame.assignment_id !== s.assignmentId ||
      (this.#contextId !== undefined && frame.transport_id !== this.#contextId)
    )
      throw Error('Pause context scope mismatch')
  }
  private async frame(frame: PauseSignallingServerFrame) {
    if (!this.#channel.current()) return
    if (frame.t === 'pause.retry') {
      const expected =
        this.#phase === 'inbox-challenge' && !this.#inboxId
          ? 'inbox'
          : this.#phase === 'context-challenge' && !this.#contextNonce
            ? 'context'
            : undefined
      if (frame.phase !== expected || this.#retry)
        throw Error('Unexpected pause retry')
      const end = this.#channel.deadlines().authDeadline
      if (
        end === undefined ||
        this.#channel.now() + frame.retry_after_ms >= end
      )
        throw Error('Retry exceeds original admission')
      this.#retry = setTimeout(() => {
        this.#retry = undefined
        if (this.#channel.current()) {
          try {
            this.#channel.send({ v: 1, t: 'pause.connector-retry' })
          } catch {
            /* Channel already closed. */
          }
        }
      }, frame.retry_after_ms)
      return
    }
    if (
      frame.t === 'pause.connector-inbox-challenge' &&
      this.#phase === 'inbox-challenge' &&
      !this.#inboxId
    ) {
      clearTimeout(this.#retry)
      this.#retry = undefined
      const c = frame.challenge
      this.validateChallenge(c, c.connection_id)
      this.#channel.beginContext(c.expires_at)
      if (!this.#channel.current()) return
      this.#inboxId = c.connection_id
      this.#inboxGeneration = c.generation
      this.#inboxNonce = c.nonce
      const signature = this.sign(c, this.#inboxId)
      if (!this.#channel.current()) return
      this.#phase = 'inbox-ready'
      this.#channel.send({ v: 1, t: 'pause.connector-inbox-proof', signature })
      return
    }
    if (
      frame.t === 'pause.connector-inbox-ready' &&
      this.#phase === 'inbox-ready' &&
      frame.inbox_id === this.#inboxId
    ) {
      this.#channel.capLease(frame)
      if (!this.#channel.current()) return
      this.#channel.completeAdmission()
      this.#phase = 'context-request'
      pauseSynchronous(() => this.#options.onInboxReady?.())
      return
    }
    if (
      frame.t === 'pause.context-request' &&
      this.#phase === 'context-request' &&
      frame.transport_id !== this.#inboxId
    ) {
      this.scopeMatches(frame)
      if (this.#channel.wallNow() < frame.issued_at)
        throw Error('Future pause context notice')
      this.#contextId = frame.transport_id
      this.#channel.beginContext(frame.expires_at)
      if (!this.#channel.current()) return
      this.#phase = 'context-challenge'
      this.#channel.send({
        v: 1,
        t: 'pause.connector-attach',
        transport_id: frame.transport_id,
        farm_id: this.#scope.farmId,
        agent_id: this.#scope.agentId,
        assignment_id: this.#scope.assignmentId,
        token: this.#scope.token,
      })
      return
    }
    if (
      frame.t === 'pause.context-challenge' &&
      this.#phase === 'context-challenge' &&
      this.#contextId
    ) {
      this.scopeMatches(frame)
      clearTimeout(this.#retry)
      this.#retry = undefined
      const c = frame.challenge
      this.validateChallenge(c, this.#contextId)
      if (c.generation <= this.#inboxGeneration || c.nonce === this.#inboxNonce)
        throw Error('Replayed pause context challenge')
      this.#channel.beginContext(c.expires_at)
      if (!this.#channel.current()) return
      this.#contextNonce = c.nonce
      const signature = this.sign(c, this.#contextId)
      if (!this.#channel.current()) return
      this.#phase = 'rtc-ready'
      this.#channel.send({
        v: 1,
        t: 'pause.connector-context-proof',
        signature,
      })
      return
    }
    if (
      frame.t === 'pause.ready' &&
      this.#phase === 'rtc-ready' &&
      this.#contextId
    ) {
      this.scopeMatches(frame)
      this.#channel.capLease(frame)
      if (!this.#channel.current()) return
      const caps = this.#channel.deadlines(),
        s = this.#scope
      const input: PeerOptions = {
        identity: s.identity,
        expected: {
          transportId: this.#contextId,
          farmId: s.farmId,
          agentId: s.agentId,
          assignmentId: s.assignmentId,
          origin: s.origin,
          audience: s.audience,
          ...(s.accountId !== undefined ? { accountId: s.accountId } : {}),
          ...(s.keyId !== undefined ? { keyId: s.keyId } : {}),
        },
        expectedBinding: this.#binding,
        ...(caps.authDeadline !== undefined
          ? { authDeadline: caps.authDeadline }
          : {}),
        lifetimeDeadline: caps.lifetimeDeadline,
        onProofsReady: (ready) => this.proofsReady(ready),
        onPhase: (value) => {
          if (!this.#channel.current() || !this.#ready) return
          const frame = PauseChannelFrame.parse(value)
          if (
            (frame.t !== 'control.capability' &&
              frame.t !== 'control.admission-proof') ||
            frame.transport_id !== this.#contextId
          )
            throw Error('Unexpected pause metadata')
          pauseSynchronous(() => this.#options.onPhase?.(Object.freeze(frame)))
        },
        onTerminal: (reason) => this.#channel.close(reason),
      }
      const factory =
        this.#options.peerFactory ??
        (async (options: PeerOptions) => {
          const { PauseConnectorPeer } = await import(
            '../webrtc/pause-control-peer.ts'
          )
          return new PauseConnectorPeer(options)
        })
      const loading = Promise.resolve()
        .then(() => factory(input))
        .then((peer) => {
          if (!this.#channel.current()) {
            this.closePeer(peer, 'late-peer')
            return undefined
          }
          this.#peer = peer
          return peer
        })
      this.#peerSettlement = loading.then(
        () => {},
        () => {},
      )
      const peer = await loading
      if (!peer || !this.#channel.current()) return
      this.#phase = 'answer'
      const offer = await peer.offer()
      if (!this.#channel.current()) return
      this.#channel.send({
        v: 1,
        t: 'rtc.offer',
        transport_id: this.#contextId,
        seq: 0,
        p: { sdp: offer },
      })
      return
    }
    if (
      frame.t === 'rtc.answer' &&
      this.#phase === 'answer' &&
      frame.transport_id === this.#contextId &&
      frame.seq === 0 &&
      this.#peer
    ) {
      this.#phase = 'binding'
      this.#peer.answer(frame.p.sdp)
      return
    }
    if (frame.t === 'pause.binding' && this.#phase === 'binding') {
      const b = ControlSessionBinding.parse(frame.binding),
        s = this.#scope
      this.scopeMatches(b)
      if (
        b.transport_id !== this.#contextId ||
        b.credential_jti !== s.jti ||
        b.origin !== s.origin ||
        b.audience !== s.audience ||
        b.connector_public_key_spki !== this.#publicKey ||
        b.connector_fingerprint !== this.#fingerprint ||
        b.connector_nonce !== this.#contextNonce ||
        (s.accountId !== undefined && b.account_id !== s.accountId) ||
        (s.keyId !== undefined && b.key_id !== s.keyId)
      )
        throw Error('Pause binding scope mismatch')
      this.#channel.capLease(b)
      if (!this.#channel.current()) return
      Object.freeze(b.browser_public_key)
      Object.freeze(b)
      this.#serverBinding = b
      this.#phase = 'active'
      this.#resolveBinding(b)
      return
    }
    throw Error('Unexpected pause signalling frame')
  }
  private proofsReady(value: PauseProofsReady) {
    if (!this.#channel.current()) return
    try {
      if (this.#phase !== 'active' || this.#ready || !this.#serverBinding)
        throw Error('Unexpected pause readiness')
      const binding = ControlSessionBinding.parse(value.binding)
      if (
        canonicalize(binding) !== canonicalize(this.#serverBinding) ||
        !Number.isFinite(value.deadlineMonoMs) ||
        value.deadlineMonoMs <= this.#channel.now()
      )
        throw Error('Pause readiness scope mismatch')
      for (const [role, wire] of [
        ['browser', value.browserProofWire],
        ['connector', value.connectorProofWire],
      ] as const) {
        const proof = decodeControlProof(wire)
        if (
          proof.role !== role ||
          canonicalize(proof.binding) !== canonicalize(binding)
        )
          throw Error('Pause readiness proof mismatch')
      }
      if (!this.#channel.current()) return
      Object.freeze(binding.browser_public_key)
      Object.freeze(binding)
      const ready = Object.freeze({
        binding,
        deadlineMonoMs: Math.min(
          value.deadlineMonoMs,
          this.#channel.deadlines().lifetimeDeadline,
        ),
        browserProofWire: value.browserProofWire,
        connectorProofWire: value.connectorProofWire,
      })
      this.#ready = ready
      this.#channel.completeAdmission()
      pauseSynchronous(() => this.#options.onProofsReady?.(ready))
      if (this.#channel.current()) this.#resolve()
    } catch {
      this.#channel.close('proofs-ready-callback')
    }
  }
  sendPhase(message: PausePhaseMessage): boolean {
    if (!this.#ready || !this.#channel.current()) return false
    if (message.t !== 'control.admission-nonce') {
      this.#channel.close('invalid-phase-send')
      return false
    }
    return this.#peer?.sendPhase(message) ?? false
  }
  close(reason = 'closed') {
    this.#channel.close(reason)
  }
  dispose(timeoutMs: number): Promise<void> {
    if (this.#disposal) return this.#disposal
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
      return Promise.reject(Error('Invalid pause disposal timeout'))
    const deadline = performance.now() + timeoutMs
    this.#disposal = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            await Promise.all([
              this.#channel.dispose(timeoutMs),
              this.#peerSettlement,
            ])
            await Promise.all([...this.#peerClosures])
            if (this.#peerCloseFailed) throw Error('Pause peer close failed')
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('Pause client disposal timed out')),
              Math.max(0, deadline - performance.now()),
            )
          }),
        ])
        if (performance.now() >= deadline)
          throw Error('Pause client disposal timed out')
      } finally {
        clearTimeout(timer)
      }
    })
    this.close('disposed')
    return this.#disposal
  }
  diagnostics() {
    const actual = this.#options.peerFactory
      ? undefined
      : this.#peer?.diagnostics()
    return Object.freeze({
      certificateMatched: actual?.certificateMatched ?? false,
      sentProofs: actual?.sentProofs ?? 0,
      receivedProofs: actual?.receivedProofs ?? 0,
      terminal:
        this.#channel.snapshot().state === 'readonly' ||
        actual?.terminal === true,
      commandsEnabled: false as const,
    })
  }
  snapshot() {
    return { phase: this.#phase, ...this.#channel.snapshot() }
  }
}
