import { createHash, createPublicKey } from 'node:crypto'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../farm-protocol/src/pairing-proof.ts'
import {
  SignallingClientControl,
  type SignallingServerFrame,
  MAX_SIGNALLING_SOCKET_BYTES,
} from '../../../farm-protocol/src/signalling-socket.ts'
import { RtcSessionBinding } from '../../../farm-protocol/src/rtc-session-binding.ts'
import { ConnectorIdentity } from '../identity/store.ts'
import {
  SignallingClientChannel,
  type SocketPort,
  type ChannelClock,
} from '../webrtc/signalling-client-channel.ts'
import type { ReadonlyConnectorPeer } from '../webrtc/readonly-peer.ts'
type NativeSocket = {
  readyState: number
  protocol: string
  bufferedAmount: number
  send(wire: string, done: (error?: Error) => void): void
  on(event: 'open' | 'error' | 'close', handler: () => void): unknown
  on(
    event: 'message',
    handler: (data: import('ws').RawData, binary: boolean) => void,
  ): unknown
  off(event: 'open' | 'error' | 'close', handler: () => void): unknown
  off(
    event: 'message',
    handler: (data: import('ws').RawData, binary: boolean) => void,
  ): unknown
  terminate(): void
}
type WsOptions = {
  maxPayload: number
  perMessageDeflate: false
  followRedirects: false
  allowSynchronousEvents: true
  skipUTF8Validation: false
  maxFragments: number
  maxBufferedChunks: number
  autoPong: false
}
type WsConstructor = new (
  url: URL,
  protocol: string,
  options: WsOptions,
) => NativeSocket
/** Startup flags must precede EVERY ws import in the process. A cached earlier
 * import cannot be retroactively attested as addon-free. No environment mutation.
 */
export async function connectorSocket(
  url: string,
  load: () => Promise<{ WebSocket: WsConstructor }> = () => import('ws'),
): Promise<SocketPort> {
  if (
    process.env.WS_NO_BUFFER_UTIL !== '1' ||
    process.env.WS_NO_UTF_8_VALIDATE !== '1'
  )
    throw Error('Pure JS WebSocket startup flags required')
  const target = new URL(url)
  if (
    target.protocol !== 'wss:' ||
    target.pathname !== '/api/signalling/connector' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw Error('Invalid signalling destination')
  const module = await load()
  const options: Readonly<WsOptions> = Object.freeze({
    maxPayload: MAX_SIGNALLING_SOCKET_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
    allowSynchronousEvents: true,
    skipUTF8Validation: false,
    maxFragments: 16,
    maxBufferedChunks: 16,
    autoPong: false,
  })
  const socket = new module.WebSocket(
    target,
    'open3dfarm.signalling.v1',
    options,
  )
  const ignore = () => {}
  socket.on('error', ignore)
  return {
    isOpen: () => socket.readyState === 1,
    bufferedBytes: () => socket.bufferedAmount,
    send: (wire, done) =>
      socket.send(wire, (error) => done(error ?? undefined)),
    bind: (handlers) => {
      const open = () =>
        socket.protocol === 'open3dfarm.signalling.v1'
          ? handlers.open()
          : handlers.error()
      const message = (data: import('ws').RawData, binary: boolean) => {
        // ws delivers text as Buffer by default. Check before decoding/copying.
        if (
          binary ||
          !Buffer.isBuffer(data) ||
          data.byteLength > MAX_SIGNALLING_SOCKET_BYTES
        ) {
          handlers.error()
          return
        }
        handlers.message(data.toString('utf8'))
      }
      socket.on('open', open)
      socket.on('message', message)
      socket.on('error', handlers.error)
      socket.on('close', handlers.close)
      return () => {
        socket.off('open', open)
        socket.off('message', message)
        socket.off('error', handlers.error)
        socket.off('close', handlers.close)
      }
    },
    close: () => socket.terminate(),
  }
}
type Peer = Pick<ReadonlyConnectorPeer, 'offer' | 'answer' | 'close'>
type PeerOptions = ConstructorParameters<typeof ReadonlyConnectorPeer>[0]
type Scope = {
  url: string
  origin: string
  audience: string
  agentId: string
  farmId: string
  jti: string
  token: string
  identity: ConnectorIdentity
}
type Options = {
  socketFactory?: () => SocketPort | Promise<SocketPort>
  peerFactory?: (input: PeerOptions) => Peer | Promise<Peer>
  clock?: ChannelClock
}
/** Detached client. Server 0014 PoP/current-authority checks remain mandatory.
 * JWT/lookup IDs and challenge generation grant no transport or command authority.
 * Native RTC currently binds127.0.0.1 only; this client does not broaden networking.
 */
export class AuthenticatedConnectorSignallingClient {
  #scope: Readonly<Scope>
  #channel: SignallingClientChannel
  #options: Readonly<Options>
  #begin: Extract<SignallingClientControl, { t: 'connector.begin' }>
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
  #retry: ReturnType<typeof setTimeout> | undefined
  #completion: Promise<void> | undefined
  #resolve: () => void = () => {}
  #reject: (error: Error) => void = () => {}
  #resolveBinding: (value: unknown) => void = () => {}
  #binding = new Promise<unknown>((resolve) => {
    this.#resolveBinding = resolve
  })
  constructor(scope: Scope, options: Options = {}) {
    const begin = SignallingClientControl.parse({
      v: 1,
      t: 'connector.begin',
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      jti: scope.jti,
      token: scope.token,
    })
    // Discriminant narrowing is retained after the authoritative parser.
    if (begin.t !== 'connector.begin') throw Error('Connector begin expected')
    this.#begin = begin
    const origin = PairingProofOrigin.parse(scope.origin),
      audience = PairingProofAudience.parse(scope.audience)
    const target = new URL(scope.url)
    if (
      target.protocol !== 'wss:' ||
      target.host !== new URL(origin).host ||
      target.pathname !== '/api/signalling/connector' ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw Error('Signalling origin mismatch')
    this.#scope = Object.freeze({ ...scope, origin, audience })
    this.#options = Object.freeze({ ...options })
    this.#publicKey = scope.identity.publicKeySpki
    this.#fingerprint = scope.identity.fingerprint
    const jwk = createPublicKey({
      key: Buffer.from(this.#publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    }).export({ format: 'jwk' })
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string')
      throw Error('Expected owned Ed25519 public JWK')
    // RFC7638 public members, through the existing canonicalizer, matching server.
    this.#thumbprint = createHash('sha256')
      .update(canonicalize({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))
      .digest('base64url')
    this.#tokenHash = createHash('sha256')
      .update(scope.token)
      .digest('base64url')
    this.#channel = new SignallingClientChannel({
      ...(options.clock ? { clock: options.clock } : {}),
      onOpen: () => {
        if (this.#phase !== 'open') throw Error('Unexpected open')
        this.#phase = 'inbox-challenge'
        this.#channel.send(this.#begin)
      },
      onFrame: (frame) => this.frame(frame),
      onTerminal: (reason) => {
        clearTimeout(this.#retry)
        try {
          this.#peer?.close(reason)
        } finally {
          this.#reject(Error('Signalling readonly: ' + reason))
        }
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
      this.#reject(Error('Client terminal'))
      return this.#completion
    }
    this.#channel.connect(
      this.#options.socketFactory ?? (() => connectorSocket(this.#scope.url)),
    )
    return this.#completion
  }
  private validateChallenge(
    c: Extract<
      SignallingServerFrame,
      { t: 'connector.inbox-challenge' }
    >['challenge'],
    connectionId: string,
  ) {
    const s = this.#scope,
      now = this.#channel.wallNow()
    if (
      c.agent_id !== s.agentId ||
      c.farm_id !== s.farmId ||
      c.jti !== s.jti ||
      c.connection_id !== connectionId ||
      c.origin !== s.origin ||
      c.audience !== s.audience ||
      c.purpose !== 'signalling' ||
      c.public_key_spki !== this.#publicKey ||
      c.fingerprint !== this.#fingerprint ||
      c.thumbprint !== this.#thumbprint ||
      c.token_hash !== this.#tokenHash ||
      now < c.issued_at ||
      now >= c.expires_at
    )
      throw Error('Untrusted credential challenge')
  }
  private proof(
    c: Extract<
      SignallingServerFrame,
      { t: 'connector.inbox-challenge' }
    >['challenge'],
    connectionId: string,
  ) {
    return this.#scope.identity.signCredentialProof({
      challenge: c,
      token: this.#scope.token,
      expectedOrigin: this.#scope.origin,
      expectedAudience: this.#scope.audience,
      expectedPurpose: 'signalling',
      expectedConnectionId: connectionId,
      now: this.#channel.wallNow(),
    })
  }
  private async frame(frame: SignallingServerFrame) {
    if (!this.#channel.current()) return
    if (frame.t === 'retry') {
      const expected =
        this.#phase === 'inbox-challenge'
          ? 'inbox'
          : this.#phase === 'context-challenge'
            ? 'context'
            : undefined
      if (frame.phase !== expected || this.#retry)
        throw Error('Unexpected retry')
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
            this.#channel.send({ v: 1, t: 'connector.retry' })
          } catch {
            /* send already closed the channel */
          }
        }
      }, frame.retry_after_ms)
      return
    }
    if (
      frame.t === 'connector.inbox-challenge' &&
      this.#phase === 'inbox-challenge' &&
      !this.#inboxId
    ) {
      clearTimeout(this.#retry)
      this.#retry = undefined
      const c = frame.challenge
      this.validateChallenge(c, c.connection_id) // First TLS-authenticated inbox UUID, pinned once.
      this.#channel.beginContext(c.expires_at)
      if (!this.#channel.current()) return
      this.#inboxId = c.connection_id
      this.#inboxGeneration = c.generation
      this.#inboxNonce = c.nonce
      const signature = this.proof(c, this.#inboxId)
      if (!this.#channel.current()) return
      this.#phase = 'inbox-ready'
      this.#channel.send({ v: 1, t: 'connector.inbox-proof', signature })
      return
    }
    if (
      frame.t === 'connector.inbox-ready' &&
      this.#phase === 'inbox-ready' &&
      frame.inbox_id === this.#inboxId
    ) {
      this.#channel.capLease(frame)
      this.#channel.completeAdmission()
      this.#phase = 'context-request'
      return
    }
    if (
      frame.t === 'connector.context-request' &&
      this.#phase === 'context-request' &&
      frame.transport_id !== this.#inboxId
    ) {
      this.#contextId = frame.transport_id
      this.#channel.beginContext(frame.expires_at)
      if (!this.#channel.current()) return
      this.#phase = 'context-challenge'
      this.#channel.send({
        v: 1,
        t: 'connector.attach',
        token: this.#scope.token,
      })
      return
    }
    if (
      frame.t === 'connector.context-challenge' &&
      this.#phase === 'context-challenge' &&
      this.#contextId
    ) {
      clearTimeout(this.#retry)
      this.#retry = undefined
      const c = frame.challenge
      this.validateChallenge(c, this.#contextId)
      if (c.generation <= this.#inboxGeneration || c.nonce === this.#inboxNonce)
        throw Error('Replayed context challenge')
      this.#channel.beginContext(c.expires_at)
      if (!this.#channel.current()) return
      this.#contextNonce = c.nonce
      const signature = this.proof(c, this.#contextId)
      if (!this.#channel.current()) return
      this.#phase = 'rtc-ready'
      this.#channel.send({ v: 1, t: 'connector.context-proof', signature })
      return
    }
    if (
      frame.t === 'rtc.ready' &&
      this.#phase === 'rtc-ready' &&
      frame.transport_id === this.#contextId
    ) {
      this.#channel.capLease(frame)
      if (!this.#channel.current()) return
      const caps = this.#channel.deadlines()
      const input: PeerOptions = {
        identity: this.#scope.identity,
        expectedAgentId: this.#scope.agentId,
        admittedBinding: this.#binding,
        ...caps,
        onVerified: () => {
          if (this.#channel.current()) {
            this.#channel.completeAdmission()
            this.#resolve()
          }
        },
        onTerminal: (reason) => this.#channel.close(reason),
      }
      const factory =
        this.#options.peerFactory ??
        (async (options) => {
          const { ReadonlyConnectorPeer } = await import(
            '../webrtc/readonly-peer.ts'
          )
          return new ReadonlyConnectorPeer(options)
        })
      const peer = await factory(input)
      if (!this.#channel.current()) {
        peer.close('late-peer')
        return
      }
      this.#peer = peer
      this.#phase = 'answer'
      const offer = await peer.offer()
      if (!this.#channel.current()) return
      this.#channel.send({
        v: 1,
        t: 'rtc.offer',
        transport_id: frame.transport_id,
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
    if (frame.t === 'rtc.binding' && this.#phase === 'binding') {
      const b = RtcSessionBinding.parse(frame.binding),
        s = this.#scope
      if (
        b.transport_id !== this.#contextId ||
        b.agent_id !== s.agentId ||
        b.farm_id !== s.farmId ||
        b.credential_jti !== s.jti ||
        b.origin !== s.origin ||
        b.audience !== s.audience ||
        b.connector_public_key_spki !== this.#publicKey ||
        b.connector_fingerprint !== this.#fingerprint ||
        b.connector_nonce !== this.#contextNonce
      )
        throw Error('Binding scope mismatch')
      this.#channel.capLease(b)
      if (!this.#channel.current()) return
      this.#phase = 'active'
      this.#resolveBinding(b)
      return
    }
    throw Error('Unexpected signalling frame')
  }
  close(reason = 'closed') {
    this.#channel.close(reason)
  }
  snapshot() {
    return { phase: this.#phase, ...this.#channel.snapshot() }
  }
}
