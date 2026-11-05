import { z } from 'zod'
import { canonicalize } from '../../../../../packages/farm-protocol/src/canonical.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  validateBrowserDevicePublicKey,
} from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import { ControlSessionBinding } from '../../../../../packages/farm-protocol/src/control-session-binding.ts'
import {
  PauseTransportProofChallenge,
  signPauseTransportProof,
  type PauseSignallingServerFrame,
} from '../../../../../packages/farm-protocol/src/pause-signalling.ts'
import {
  PauseSignallingClientChannel,
  type SocketPort,
  type ChannelClock,
} from '../../../../../packages/connector/src/webrtc/signalling-client-channel.ts'
import {
  pausePrivateKey,
  pauseSynchronous,
  type PauseProofsReady,
  type PausePhaseFrame,
  type PausePhaseMessage,
  type PauseDataFrame,
  type PauseCommandMessage,
} from '../../../../../packages/connector/src/webrtc/pause-control-session.ts'
import { PauseBrowserPeer } from './pause-control-peer.ts'

const protocol = 'open3dfarm.pause-signalling.v1'
/** Same-origin HTTPS only; no alternate endpoint, redirect or readonly fallback. */
export function pauseBrowserSocket(
  url = '/api/signalling/pause-browser',
  expectedOrigin = location.origin,
): SocketPort {
  const origin = PairingProofOrigin.parse(expectedOrigin)
  if (!origin.startsWith('https:') || location.origin !== origin)
    throw Error('Invalid pause page origin')
  const base = new URL(origin)
  base.protocol = 'wss:'
  const target = new URL(url, base)
  if (
    target.protocol !== 'wss:' ||
    target.host !== base.host ||
    target.pathname !== '/api/signalling/pause-browser' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw Error('Invalid pause signalling destination')
  const socket = new WebSocket(target, protocol)
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  socket.addEventListener('close', () => resolveClosed(), { once: true })
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    bufferedBytes: () => socket.bufferedAmount,
    send: (wire, done) => {
      socket.send(wire)
      done()
    },
    bind: (handlers) => {
      const open = () =>
        socket.protocol === protocol ? handlers.open() : handlers.error()
      const message = (event: MessageEvent) => handlers.message(event.data)
      socket.addEventListener('open', open)
      socket.addEventListener('message', message)
      socket.addEventListener('error', handlers.error)
      socket.addEventListener('close', handlers.close)
      return () => {
        socket.removeEventListener('open', open)
        socket.removeEventListener('message', message)
        socket.removeEventListener('error', handlers.error)
        socket.removeEventListener('close', handlers.close)
      }
    },
    close: () => socket.close(),
    waitClosed: () => closed,
  }
}
const Scope = z.strictObject({
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  assignmentId: BrowserDeviceUuid,
  keyId: BrowserDeviceUuid,
  accountId: BrowserDeviceTextId,
  origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
  audience: PairingProofAudience,
})
export type PauseBrowserSignallingScope = z.infer<typeof Scope> & {
  publicKey: unknown
  privateKey: CryptoKey
}
type PeerOptions = ConstructorParameters<typeof PauseBrowserPeer>[0]
type Peer = Pick<
  PauseBrowserPeer,
  'answer' | 'close' | 'closed' | 'sendPhase'
> &
  Partial<Pick<PauseBrowserPeer, 'diagnostics' | 'sendCommand'>>
type Options = Readonly<{
  peerFactory?: (input: PeerOptions) => Peer
  clock?: ChannelClock
  signal?: AbortSignal
  onProofsReady?: (value: PauseProofsReady) => void
  onPhase?: (frame: Readonly<PausePhaseFrame>) => void
  /** Optional result handler. Absent keeps the client metadata only. */
  onData?: (frame: Readonly<PauseDataFrame>) => void
  onTerminal?: (reason: string) => void
}>
/** A new authenticated control transport, never a readonly peer upgrade or command dispatcher. */
export class PauseBrowserSignallingClient {
  #scope: Readonly<PauseBrowserSignallingScope>
  #options: Options
  #channel: PauseSignallingClientChannel
  #phase: 'open' | 'challenge' | 'ready' | 'offer' | 'binding' | 'active' =
    'open'
  #transport: string | undefined
  #nonce: string | undefined
  #thumbprint: string | undefined
  #peer: Peer | undefined
  #factory: (input: PeerOptions) => Peer
  #defaultPeer: boolean
  #bindingValue: ControlSessionBinding | undefined
  #proofsReady = false
  #resolveBinding!: (value: unknown) => void
  #binding = new Promise<unknown>((resolve) => {
    this.#resolveBinding = resolve
  })
  #resolveStart!: () => void
  #rejectStart!: (error: Error) => void
  #started = false
  #start = new Promise<void>((resolve, reject) => {
    this.#resolveStart = resolve
    this.#rejectStart = reject
  })
  #removeAbort = () => {}
  constructor(input: PauseBrowserSignallingScope, options: Options = {}) {
    const { publicKey, privateKey, ...scope } = input
    pausePrivateKey(privateKey)
    this.#scope = Object.freeze({
      ...Scope.parse(scope),
      publicKey: structuredClone(publicKey),
      privateKey,
    })
    this.#options = Object.freeze({ ...options })
    this.#defaultPeer = options.peerFactory === undefined
    this.#factory =
      options.peerFactory ?? ((value) => new PauseBrowserPeer(value))
    void this.#start.catch(() => {})
    this.#channel = new PauseSignallingClientChannel({
      ...(options.clock ? { clock: options.clock } : {}),
      onOpen: () => {
        if (this.#phase !== 'open') throw Error('Unexpected pause open')
        this.#phase = 'challenge'
        this.#channel.send({
          v: 1,
          t: 'pause.begin',
          farm_id: this.#scope.farmId,
          agent_id: this.#scope.agentId,
          key_id: this.#scope.keyId,
          assignment_id: this.#scope.assignmentId,
        })
      },
      onFrame: (frame) => this.frame(frame),
      onTerminal: (reason) => {
        this.#removeAbort()
        this.#rejectStart(Error(reason))
        this.#resolveBinding(undefined)
        try {
          this.#peer?.close(reason)
        } finally {
          pauseSynchronous(() => this.#options.onTerminal?.(reason))
        }
      },
    })
    if (options.signal) {
      const abort = () => this.close('aborted')
      options.signal.addEventListener('abort', abort, { once: true })
      this.#removeAbort = () =>
        options.signal?.removeEventListener('abort', abort)
      if (options.signal.aborted) abort()
    }
  }
  start(
    factory: () => SocketPort | Promise<SocketPort> = () =>
      pauseBrowserSocket('/api/signalling/pause-browser', this.#scope.origin),
  ): Promise<void> {
    if (!this.#started) {
      this.#started = true
      this.#channel.connect(factory)
    }
    return this.#start
  }
  private scopeMatches(frame: {
    transport_id: string
    farm_id: string
    agent_id: string
    assignment_id: string
  }): boolean {
    return (
      frame.transport_id === this.#transport &&
      frame.farm_id === this.#scope.farmId &&
      frame.agent_id === this.#scope.agentId &&
      frame.assignment_id === this.#scope.assignmentId
    )
  }
  private async frame(frame: PauseSignallingServerFrame): Promise<void> {
    if (!this.#channel.current()) return
    const scope = this.#scope
    if (frame.t === 'pause.challenge' && this.#phase === 'challenge') {
      const c = PauseTransportProofChallenge.parse(frame.challenge)
      if (
        c.farm_id !== scope.farmId ||
        c.agent_id !== scope.agentId ||
        c.assignment_id !== scope.assignmentId ||
        c.key_id !== scope.keyId ||
        c.account_id !== scope.accountId ||
        c.origin !== scope.origin ||
        c.audience !== scope.audience
      )
        throw Error('Pause challenge scope mismatch')
      this.#channel.beginContext(c.expires_at)
      if (this.#channel.wallNow() < c.issued_at || !this.#channel.current())
        throw Error('Pause challenge expired')
      const key = await validateBrowserDevicePublicKey(scope.publicKey)
      if (!this.#channel.current()) return
      if (key.thumbprint !== c.thumbprint) throw Error('Pause key mismatch')
      const signature = await signPauseTransportProof(c, scope.privateKey)
      if (!this.#channel.current()) return
      this.#transport = c.transport_id
      this.#nonce = c.nonce
      this.#thumbprint = key.thumbprint
      this.#phase = 'ready'
      this.#channel.send({ v: 1, t: 'pause.browser-proof', signature })
      return
    }
    if (
      frame.t === 'pause.ready' &&
      this.#phase === 'ready' &&
      this.scopeMatches(frame)
    ) {
      this.#channel.capLease(frame)
      if (!this.#channel.current()) return
      const deadlines = this.#channel.deadlines()
      // Reserve the phase before a constructor can synchronously call terminal callbacks.
      this.#phase = 'offer'
      const peer = this.#factory({
        privateKey: scope.privateKey,
        expected: {
          transportId: frame.transport_id,
          farmId: scope.farmId,
          agentId: scope.agentId,
          assignmentId: scope.assignmentId,
          accountId: scope.accountId,
          keyId: scope.keyId,
          origin: scope.origin,
          audience: scope.audience,
        },
        expectedBinding: this.#binding,
        ...(deadlines.authDeadline === undefined
          ? {}
          : { authDeadline: deadlines.authDeadline }),
        lifetimeDeadline: deadlines.lifetimeDeadline,
        onProofsReady: (value) => this.verified(value),
        onPhase: (value) => {
          if (!this.#channel.current() || !this.#proofsReady) return
          if (value.transport_id !== this.#transport) {
            this.close('phase-scope')
            return
          }
          try {
            pauseSynchronous(() =>
              this.#options.onPhase?.(Object.freeze(structuredClone(value))),
            )
          } catch {
            this.close('phase-callback')
          }
        },
        onData: (value) => {
          if (!this.#channel.current() || !this.#proofsReady) return
          if (value.transport_id !== this.#transport) {
            this.close('data-scope')
            return
          }
          if (value.t !== 'control.result') {
            this.close('data-direction')
            return
          }
          try {
            pauseSynchronous(() =>
              this.#options.onData?.(Object.freeze(structuredClone(value))),
            )
          } catch {
            this.close('data-callback')
          }
        },
        onTerminal: (reason) => this.close(reason),
      })
      this.#peer = peer
      if (!this.#channel.current()) peer.close('late-peer')
      return
    }
    if (
      frame.t === 'rtc.offer' &&
      this.#phase === 'offer' &&
      frame.transport_id === this.#transport &&
      frame.seq === 0 &&
      this.#peer
    ) {
      this.#phase = 'binding'
      const answer = await this.#peer.answer(frame.p.sdp)
      if (!this.#channel.current()) return
      this.#channel.send({
        v: 1,
        t: 'rtc.answer',
        transport_id: frame.transport_id,
        seq: 0,
        p: { sdp: answer },
      })
      return
    }
    if (frame.t === 'pause.binding' && this.#phase === 'binding') {
      const b = ControlSessionBinding.parse(frame.binding)
      if (
        !this.scopeMatches(b) ||
        b.account_id !== scope.accountId ||
        b.key_id !== scope.keyId ||
        b.origin !== scope.origin ||
        b.audience !== scope.audience ||
        b.browser_thumbprint !== this.#thumbprint ||
        b.browser_nonce !== this.#nonce ||
        canonicalize(b.browser_public_key) !== canonicalize(scope.publicKey)
      )
        throw Error('Pause binding mismatch')
      this.#channel.capLease(b)
      if (!this.#channel.current()) return
      Object.freeze(b.browser_public_key)
      this.#bindingValue = Object.freeze(b)
      this.#phase = 'active'
      this.#resolveBinding(b)
      return
    }
    throw Error('Unexpected pause signalling frame')
  }
  private verified(value: PauseProofsReady): void {
    if (!this.#channel.current()) return
    if (
      this.#phase !== 'active' ||
      this.#proofsReady ||
      !this.#bindingValue ||
      canonicalize(value.binding) !== canonicalize(this.#bindingValue) ||
      !Number.isFinite(value.deadlineMonoMs) ||
      value.deadlineMonoMs <= this.#channel.now() ||
      value.deadlineMonoMs > this.#channel.deadlines().lifetimeDeadline
    ) {
      this.close('unexpected-control-proof')
      return
    }
    this.#proofsReady = true
    this.#channel.completeAdmission()
    try {
      const copy = structuredClone(value)
      Object.freeze(copy.binding.browser_public_key)
      Object.freeze(copy.binding)
      Object.freeze(copy)
      pauseSynchronous(() => this.#options.onProofsReady?.(copy))
      if (this.#channel.current()) this.#resolveStart()
    } catch {
      this.close('proof-callback')
    }
  }
  /** Admission/capability metadata only; the bounded command travels through sendCommand. */
  sendPhase(frame: PausePhaseMessage): boolean {
    if (!this.#channel.current() || !this.#proofsReady) return false
    try {
      return this.#peer?.sendPhase(frame) === true && this.#channel.current()
    } catch {
      this.close('phase-send')
      return false
    }
  }
  /** Browser only command. The client never emits a result. */
  sendCommand(command: PauseCommandMessage): boolean {
    if (!this.#channel.current() || !this.#proofsReady) return false
    if (command.t !== 'control.command') {
      this.close('invalid-data-send')
      return false
    }
    try {
      return (
        this.#peer?.sendCommand?.(command) === true && this.#channel.current()
      )
    } catch {
      this.close('command-send')
      return false
    }
  }
  close(reason = 'closed'): void {
    this.#channel.close(reason)
  }
  async dispose(timeoutMs: number): Promise<void> {
    const start = performance.now()
    await this.#channel.dispose(timeoutMs)
    if (performance.now() - start >= timeoutMs)
      throw Error('Pause peer disposal timed out')
    if (!this.#peer) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.#peer.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Pause peer disposal timed out')),
            Math.max(0, timeoutMs - (performance.now() - start)),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (performance.now() - start >= timeoutMs)
      throw Error('Pause peer disposal timed out')
  }
  diagnostics() {
    const actual = this.#defaultPeer ? this.#peer?.diagnostics?.() : undefined
    return Object.freeze({
      certificateMatched: actual?.certificateMatched ?? false,
      sentProofs: actual?.sentProofs ?? 0,
      receivedProofs: actual?.receivedProofs ?? 0,
      terminal: this.#channel.snapshot().state === 'readonly',
      commandsEnabled: false as const,
    })
  }
  snapshot() {
    return this.#channel.snapshot()
  }
}
