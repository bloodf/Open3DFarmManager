import { z } from 'zod'
import { canonicalize } from '../../../../../packages/farm-protocol/src/canonical.ts'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
  validateBrowserDevicePublicKey,
} from '../../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofAudience,
  PairingProofOrigin,
} from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import { ConfigurationSessionBinding } from '../../../../../packages/farm-protocol/src/configuration-binding.ts'
import {
  configurationFingerprint,
  configurationFresh,
  requireP256Private,
} from '../../../../../packages/farm-protocol/src/configuration-common.ts'
import {
  MAX_CONFIGURATION_SIGNALLING_WIRE_BYTES,
  decodeConfigurationSignallingServerFrame,
  encodeConfigurationSignallingClientFrame,
  type ConfigurationSignallingServerFrame,
} from '../../../../../packages/farm-protocol/src/configuration-signalling.ts'
import type {
  BrowserChannelMessage,
  ConnectorChannelMessage,
} from '../../../../../packages/connector/src/webrtc/configuration-channel.ts'
import {
  ConfigurationBrowserPeer,
  type ConfigurationBrowserPeerOptions,
  type ConfigurationProofsReady,
} from './configuration-browser-peer.ts'

export const CONFIGURATION_SIGNALLING_PROTOCOL =
  'open3dfarm.config-signalling.v1'

export interface ConfigurationBrowserSocketPort {
  isOpen(): boolean
  bufferedBytes(): number
  send(wire: string): void
  bind(handlers: {
    open(): void
    message(raw: unknown): void
    error(): void
    close(): void
  }): () => void
  close(): void
  waitClosed(): Promise<void>
}

/** Same-origin HTTPS only; no alternate endpoint, redirect or fallback. */
export function configurationBrowserSocket(
  url = '/api/signalling/config-browser',
  expectedOrigin = location.origin,
): ConfigurationBrowserSocketPort {
  const origin = PairingProofOrigin.parse(expectedOrigin)
  if (!origin.startsWith('https:') || location.origin !== origin)
    throw new Error('Invalid configuration page origin')
  const base = new URL(origin)
  base.protocol = 'wss:'
  const target = new URL(url, base)
  if (
    target.protocol !== 'wss:' ||
    target.host !== base.host ||
    target.pathname !== '/api/signalling/config-browser' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw new Error('Invalid configuration signalling destination')
  const socket = new WebSocket(target, CONFIGURATION_SIGNALLING_PROTOCOL)
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  socket.addEventListener('close', () => resolveClosed(), { once: true })
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    bufferedBytes: () => socket.bufferedAmount,
    send: (wire) => socket.send(wire),
    bind: (handlers) => {
      const open = () =>
        socket.protocol === CONFIGURATION_SIGNALLING_PROTOCOL
          ? handlers.open()
          : handlers.error()
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
  keyId: BrowserDeviceUuid,
  accountId: BrowserDeviceTextId,
  connectorFingerprint: configurationFingerprint,
  origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
  audience: PairingProofAudience,
})

export type ConfigurationBrowserSignallingScope = z.infer<typeof Scope> & {
  publicKey: unknown
  privateKey: CryptoKey
}

type Peer = Pick<
  ConfigurationBrowserPeer,
  'answer' | 'close' | 'closed' | 'sendMessage'
> &
  Partial<Pick<ConfigurationBrowserPeer, 'diagnostics'>>

export type ConfigurationBrowserSignallingOptions = Readonly<{
  peerFactory?: (input: ConfigurationBrowserPeerOptions) => Peer
  clock?: () => number
  signal?: AbortSignal
  onProofsReady?: (
    value: ConfigurationProofsReady & { advertisedRevision: number },
  ) => void
  onMessage?: (
    message: Readonly<
      Extract<ConnectorChannelMessage, { t: 'response' | 'inventory-result' }>
    >,
  ) => void
  onTerminal?: (reason: string) => void
}>

/**
 * Dedicated config-v1 browser signalling client. Establishes one authenticated
 * configuration WebRTC transport; never shares state with read-only or pause
 * transports.
 */
export class ConfigurationBrowserSignallingClient {
  #scope: Readonly<ConfigurationBrowserSignallingScope>
  #options: ConfigurationBrowserSignallingOptions
  #clock: () => number
  #socket: ConfigurationBrowserSocketPort | undefined
  #unbindSocket = () => {}
  #phase: 'open' | 'ready' | 'offer' | 'binding' | 'active' | 'closed' = 'open'
  #transportId: string | undefined
  #browserNonce: string | undefined
  #thumbprint: string | undefined
  #advertisedRevision: number | undefined
  #peer: Peer | undefined
  #factory: (input: ConfigurationBrowserPeerOptions) => Peer
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
  #terminal: string | undefined
  #removeAbort = () => {}
  #openTimer: ReturnType<typeof setTimeout> | undefined
  #leaseTimer: ReturnType<typeof setTimeout> | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(
    input: ConfigurationBrowserSignallingScope,
    options: ConfigurationBrowserSignallingOptions = {},
  ) {
    const { publicKey, privateKey, ...scope } = input
    requireP256Private(privateKey, 'configuration')
    this.#scope = Object.freeze({
      ...Scope.parse(scope),
      publicKey: structuredClone(publicKey),
      privateKey,
    })
    this.#options = Object.freeze({ ...options })
    this.#clock = options.clock ?? Date.now
    this.#factory =
      options.peerFactory ?? ((value) => new ConfigurationBrowserPeer(value))
    void this.#start.catch(() => {})
    if (options.signal) {
      const abort = () => this.close('aborted')
      options.signal.addEventListener('abort', abort, { once: true })
      this.#removeAbort = () =>
        options.signal?.removeEventListener('abort', abort)
      if (options.signal.aborted) abort()
    }
  }

  start(
    factory: () =>
      | ConfigurationBrowserSocketPort
      | Promise<ConfigurationBrowserSocketPort> = () =>
      configurationBrowserSocket(
        '/api/signalling/config-browser',
        this.#scope.origin,
      ),
  ): Promise<void> {
    if (!this.#started && !this.#terminal) {
      this.#started = true
      this.#openTimer = setTimeout(() => this.close('open-deadline'), 10_000)
      void Promise.resolve()
        .then(() => factory())
        .then((socket) => {
          if (this.#terminal) {
            socket.close()
            return
          }
          this.#socket = socket
          this.#unbindSocket = socket.bind({
            open: () => {
              if (this.#terminal || this.#phase !== 'open') {
                this.close('unexpected-open')
                return
              }
              this.#phase = 'ready'
              this.sendSignalling({
                v: 1,
                t: 'config.begin',
                farm_id: this.#scope.farmId,
                agent_id: this.#scope.agentId,
                key_id: this.#scope.keyId,
              })
            },
            message: (raw) => {
              this.#queue = this.#queue
                .then(() => this.onRawFrame(raw))
                .catch(() => this.close('frame-failed'))
            },
            error: () => this.close('socket-error'),
            close: () => this.close('socket-closed'),
          })
        })
        .catch(() => this.close('connect-failed'))
    }
    return this.#start
  }

  private sendSignalling(frame: unknown): void {
    if (this.#terminal || !this.#socket?.isOpen())
      throw new Error('Configuration signalling socket unavailable')
    const wire = encodeConfigurationSignallingClientFrame(frame)
    if (
      this.#socket.bufferedBytes() + new TextEncoder().encode(wire).byteLength >
      4 * MAX_CONFIGURATION_SIGNALLING_WIRE_BYTES
    )
      throw new Error('Configuration signalling outbound backlog')
    this.#socket.send(wire)
  }

  private async onRawFrame(raw: unknown): Promise<void> {
    if (this.#terminal) return
    const frame = decodeConfigurationSignallingServerFrame(raw)
    await this.onFrame(frame)
  }

  private async onFrame(
    frame: ConfigurationSignallingServerFrame,
  ): Promise<void> {
    if (this.#terminal) return
    const scope = this.#scope
    if (frame.t === 'config.ready' && this.#phase === 'ready') {
      if (
        frame.farm_id !== scope.farmId ||
        frame.agent_id !== scope.agentId ||
        frame.key_id !== scope.keyId ||
        !configurationFresh(frame, this.#clock(), 5000)
      )
        throw new Error('Configuration ready frame mismatch')
      const key = await validateBrowserDevicePublicKey(scope.publicKey)
      if (this.#terminal) return
      clearTimeout(this.#openTimer)
      this.#transportId = frame.transport_id
      this.#browserNonce = frame.browser_nonce
      this.#thumbprint = key.thumbprint
      this.#advertisedRevision = frame.revision
      const remainingMs = Math.max(0, frame.expires_at - this.#clock())
      const nowMono = performance.now()
      clearTimeout(this.#leaseTimer)
      this.#leaseTimer = setTimeout(
        () => this.close('lease-expired'),
        remainingMs,
      )
      this.#phase = 'offer'
      const peer = this.#factory({
        privateKey: scope.privateKey,
        expected: {
          transportId: frame.transport_id,
          farmId: scope.farmId,
          agentId: scope.agentId,
          accountId: scope.accountId,
          keyId: scope.keyId,
          browserThumbprint: key.thumbprint,
          connectorFingerprint: scope.connectorFingerprint,
          origin: scope.origin,
          audience: scope.audience,
        },
        expectedBinding: this.#binding,
        authDeadline: nowMono + Math.min(10_000, remainingMs),
        lifetimeDeadline: nowMono + Math.min(30_000, remainingMs),
        clock: this.#clock,
        onProofsReady: (value) => {
          if (this.#terminal || this.#proofsReady) return
          this.#proofsReady = true
          this.#resolveStart()
          this.#options.onProofsReady?.(
            Object.freeze({
              ...value,
              advertisedRevision: this.#advertisedRevision ?? 0,
            }),
          )
        },
        onMessage: (message) => {
          if (this.#terminal || !this.#proofsReady) return
          this.#options.onMessage?.(message)
        },
        onTerminal: (reason) => this.close(reason),
      })
      this.#peer = peer
      if (this.#terminal) peer.close('late-peer')
      return
    }
    if (
      frame.t === 'rtc.offer' &&
      this.#phase === 'offer' &&
      frame.transport_id === this.#transportId &&
      frame.seq === 0 &&
      this.#peer
    ) {
      this.#phase = 'binding'
      const answer = await this.#peer.answer(frame.p.sdp)
      if (this.#terminal) return
      this.sendSignalling({
        v: 1,
        t: 'rtc.answer',
        transport_id: frame.transport_id,
        seq: 0,
        p: { sdp: answer },
      })
      return
    }
    if (frame.t === 'config.binding' && this.#phase === 'binding') {
      const b = ConfigurationSessionBinding.parse(frame.binding)
      if (
        b.transport_id !== this.#transportId ||
        b.farm_id !== scope.farmId ||
        b.agent_id !== scope.agentId ||
        b.account_id !== scope.accountId ||
        b.key_id !== scope.keyId ||
        b.origin !== scope.origin ||
        b.audience !== scope.audience ||
        b.browser_thumbprint !== this.#thumbprint ||
        b.browser_nonce !== this.#browserNonce ||
        b.connector_fingerprint !== scope.connectorFingerprint ||
        canonicalize(b.browser_public_key) !== canonicalize(scope.publicKey) ||
        !configurationFresh(b, this.#clock(), 5000)
      )
        throw new Error('Configuration binding mismatch')
      const remainingMs = Math.max(0, b.expires_at - this.#clock())
      clearTimeout(this.#leaseTimer)
      this.#leaseTimer = setTimeout(
        () => this.close('binding-expired'),
        remainingMs,
      )
      Object.freeze(b.browser_public_key)
      this.#phase = 'active'
      this.#resolveBinding(Object.freeze(b))
      return
    }
    if (
      (frame.t === 'config.context-closed' || frame.t === 'rtc.close') &&
      frame.transport_id === this.#transportId
    ) {
      this.close('context-closed')
      return
    }
    throw new Error('Unexpected configuration signalling frame')
  }

  sendMessage(message: BrowserChannelMessage): boolean {
    if (this.#terminal || !this.#proofsReady || !this.#peer) return false
    return this.#peer.sendMessage(message)
  }

  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    this.#phase = 'closed'
    this.#removeAbort()
    clearTimeout(this.#openTimer)
    clearTimeout(this.#leaseTimer)
    this.#unbindSocket()
    this.#rejectStart(new Error(this.#terminal))
    this.#resolveBinding(undefined)
    try {
      this.#socket?.close()
    } catch {
      /* already closed */
    }
    try {
      this.#peer?.close(this.#terminal)
    } finally {
      this.#options.onTerminal?.(this.#terminal)
    }
  }

  async dispose(timeoutMs = 3000): Promise<void> {
    this.close('disposed')
    const waits = [this.#peer?.closed, this.#socket?.waitClosed()].filter(
      Boolean,
    )
    await Promise.race([
      Promise.allSettled(waits),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }
}
