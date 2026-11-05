import {
  immutableAdmission,
  runSynchronous,
  snapshotAssignmentRefs,
  validatedStatusMessage,
  type VerifiedRtcAdmission,
  type GenuineStatusOptions,
} from '../../../../../packages/connector/src/webrtc/readonly-session.ts'
import {
  BrowserTransportProofChallenge,
  signBrowserTransportProof,
} from '../../../../../packages/farm-protocol/src/browser-transport-proof.ts'
import {
  BrowserDeviceUuid,
  validateBrowserDevicePublicKey,
} from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { RtcSessionBinding } from '../../../../../packages/farm-protocol/src/rtc-session-binding.ts'
import type { SignallingServerFrame } from '../../../../../packages/farm-protocol/src/signalling-socket.ts'
import {
  SignallingClientChannel,
  type SocketPort,
} from '../../../../../packages/connector/src/webrtc/signalling-client-channel.ts'
import { ReadonlyBrowserPeer } from './readonly-peer.ts'

const protocol = 'open3dfarm.signalling.v1'
export function browserSocket(url: string): SocketPort {
  const target = new URL(url, location.href)
  const expected = location.protocol === 'https:' ? 'wss:' : 'ws:'
  if (
    target.protocol !== expected ||
    target.host !== location.host ||
    target.pathname !== '/api/signalling/browser' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw Error('Invalid signalling destination')
  const socket = new WebSocket(target, protocol)
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
  }
}
type Scope = {
  farmId: string
  agentId: string
  keyId: string
  accountId: string
  origin: string
  audience: string
  publicKey: unknown
  privateKey: CryptoKey
}
type Peer = Partial<Pick<ReadonlyBrowserPeer, 'diagnostics'>> & {
  answer(sdp: string): Promise<string>
  close(reason?: string): void
}
type PeerOptions = {
  privateKey: CryptoKey
  expectedAgentId: string
  admittedBinding: Promise<unknown>
  authDeadline?: number | undefined
  lifetimeDeadline?: number
  genuineStatus?: GenuineStatusOptions
  onVerifiedAdmission?: (admission: VerifiedRtcAdmission) => void
  onVerified?: () => void
  onTerminal?: (reason: string) => void
}
export class AuthenticatedBrowserSignallingClient {
  #channel: SignallingClientChannel
  #scope: Readonly<Scope>
  #phase: 'open' | 'challenge' | 'ready' | 'offer' | 'binding' | 'active' =
    'open'
  #transport: string | undefined
  #nonce: string | undefined
  #thumbprint: string | undefined
  #admission: VerifiedRtcAdmission | undefined
  #options: Readonly<{
    genuineStatus?: GenuineStatusOptions
    onVerifiedAdmission?: (admission: VerifiedRtcAdmission) => void
    onTerminal?: (reason: string) => void
  }>
  #peer: Peer | undefined
  #resolveBinding: (value: unknown) => void = () => {}
  #binding = new Promise<unknown>((resolve) => {
    this.#resolveBinding = resolve
  })
  #defaultPeerFactory: boolean
  #peerFactory: (options: PeerOptions) => Peer
  #started = false
  #resolveStart: () => void = () => {}
  #rejectStart: (error: Error) => void = () => {}
  #startPromise = new Promise<void>((resolve, reject) => {
    this.#resolveStart = resolve
    this.#rejectStart = reject
  })
  constructor(
    scope: Scope,
    options: {
      peerFactory?: (options: PeerOptions) => Peer
      genuineStatus?: GenuineStatusOptions
      onVerifiedAdmission?: (admission: VerifiedRtcAdmission) => void
      onTerminal?: (reason: string) => void
    } = {},
  ) {
    if (
      scope.privateKey.type !== 'private' ||
      scope.privateKey.extractable ||
      scope.privateKey.algorithm.name !== 'ECDSA' ||
      !('namedCurve' in scope.privateKey.algorithm) ||
      scope.privateKey.algorithm.namedCurve !== 'P-256'
    )
      throw Error('Nonextractable P-256 browser key required')
    void this.#startPromise.catch(() => {})
    BrowserDeviceUuid.parse(scope.farmId)
    BrowserDeviceUuid.parse(scope.agentId)
    BrowserDeviceUuid.parse(scope.keyId)
    this.#scope = Object.freeze({
      ...scope,
      publicKey: structuredClone(scope.publicKey),
    })
    this.#options = Object.freeze({
      ...options,
      ...(options.genuineStatus
        ? {
            genuineStatus: Object.freeze({
              ...options.genuineStatus,
              assignmentRefs: snapshotAssignmentRefs(
                options.genuineStatus.assignmentRefs,
                scope.agentId,
              ),
            }),
          }
        : {}),
    })
    this.#defaultPeerFactory = options.peerFactory === undefined
    this.#peerFactory =
      options.peerFactory ?? ((input) => new ReadonlyBrowserPeer(input))
    this.#channel = new SignallingClientChannel({
      onOpen: () => {
        if (this.#phase !== 'open') throw Error('Unexpected open')
        this.#phase = 'challenge'
        this.#channel.send({
          v: 1,
          t: 'browser.begin',
          farm_id: this.#scope.farmId,
          agent_id: this.#scope.agentId,
          key_id: this.#scope.keyId,
        })
      },
      onFrame: (frame) => this.frame(frame),
      onTerminal: (reason) => {
        this.#rejectStart(Error(reason))
        try {
          this.#peer?.close(reason)
        } finally {
          runSynchronous(() => this.#options.onTerminal?.(reason))
        }
      },
    })
  }
  start(
    factory: () => SocketPort | Promise<SocketPort> = () =>
      browserSocket('/api/signalling/browser'),
  ) {
    if (!this.#started) {
      this.#started = true
      this.#channel.connect(factory)
    }
    return this.#startPromise
  }
  private async frame(frame: SignallingServerFrame) {
    if (!this.#channel.current()) return
    if (frame.t === 'browser.challenge' && this.#phase === 'challenge') {
      const c = BrowserTransportProofChallenge.parse(frame.challenge),
        scope = this.#scope
      if (
        c.farm_id !== scope.farmId ||
        c.agent_id !== scope.agentId ||
        c.key_id !== scope.keyId ||
        c.account_id !== scope.accountId ||
        c.origin !== scope.origin ||
        c.audience !== scope.audience
      )
        throw Error('Challenge scope mismatch')
      this.#channel.beginContext(c.expires_at)
      if (this.#channel.wallNow() < c.issued_at || !this.#channel.current())
        throw Error('Challenge expired')
      const key = await validateBrowserDevicePublicKey(scope.publicKey)
      if (!this.#channel.current()) return
      if (key.thumbprint !== c.thumbprint) throw Error('Challenge key mismatch')
      const signature = await signBrowserTransportProof(c, scope.privateKey)
      if (!this.#channel.current()) return
      this.#transport = c.transport_id
      this.#nonce = c.nonce
      this.#thumbprint = key.thumbprint
      this.#phase = 'ready'
      this.#channel.send({ v: 1, t: 'browser.proof', signature })
      return
    }
    if (
      frame.t === 'rtc.ready' &&
      this.#phase === 'ready' &&
      frame.transport_id === this.#transport
    ) {
      this.#channel.capLease(frame)
      if (!this.#channel.current()) return
      const deadlines = this.#channel.deadlines()
      this.#peer = this.#peerFactory({
        privateKey: this.#scope.privateKey,
        expectedAgentId: this.#scope.agentId,
        admittedBinding: this.#binding,
        ...deadlines,
        ...(this.#options.genuineStatus
          ? {
              genuineStatus: {
                assignmentRefs: this.#options.genuineStatus.assignmentRefs,
                onStatus: (message) => {
                  if (this.#channel.current() && this.#admission) {
                    try {
                      const status = validatedStatusMessage(
                        message,
                        this.#options.genuineStatus!.assignmentRefs,
                      )
                      runSynchronous(() =>
                        this.#options.genuineStatus?.onStatus?.(status),
                      )
                    } catch {
                      this.#channel.close('status-callback')
                    }
                  }
                },
              },
            }
          : {}),
        onVerifiedAdmission: (admission) => {
          if (!this.#channel.current()) return
          if (this.#phase !== 'active' || this.#admission) {
            this.#channel.close('unexpected-admission')
            return
          }
          const copy = immutableAdmission(
            admission.binding,
            Math.min(
              admission.deadlineMonoMs,
              this.#channel.deadlines().lifetimeDeadline,
            ),
          )
          this.#admission = copy
          try {
            runSynchronous(() => this.#options.onVerifiedAdmission?.(copy))
          } catch {
            this.#channel.close('admission-callback')
          }
        },
        onVerified: () => {
          if (this.#phase !== 'active' || !this.#channel.current()) {
            this.#channel.close('unexpected-verification')
            return
          }
          this.#channel.completeAdmission()
          if (this.#channel.current()) this.#resolveStart()
        },
        onTerminal: (reason) => this.#channel.close(reason),
      })
      this.#phase = 'offer'
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
    if (frame.t === 'rtc.binding' && this.#phase === 'binding') {
      const b = RtcSessionBinding.parse(frame.binding),
        s = this.#scope
      if (
        b.transport_id !== this.#transport ||
        b.farm_id !== s.farmId ||
        b.agent_id !== s.agentId ||
        b.account_id !== s.accountId ||
        b.key_id !== s.keyId ||
        b.origin !== s.origin ||
        b.audience !== s.audience ||
        b.browser_thumbprint !== this.#thumbprint ||
        b.browser_nonce !== this.#nonce
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
  close() {
    this.#channel.close('closed')
  }
  /** Custom test peer factories cannot supply accepted transport evidence. */
  diagnostics() {
    const actual = this.#defaultPeerFactory
      ? this.#peer?.diagnostics?.()
      : undefined
    return Object.freeze({
      certificateMatched: actual?.certificateMatched ?? false,
      sentProofs: actual?.sentProofs ?? 0,
      receivedProofs: actual?.receivedProofs ?? 0,
      terminal:
        this.#channel.snapshot().state === 'readonly' ||
        actual?.terminal === true,
      readOnly: true as const,
    })
  }
  snapshot() {
    return this.#channel.snapshot()
  }
}
