import { createHash, createPublicKey } from 'node:crypto'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { CONFIGURATION_PROTOCOL } from '../../../farm-protocol/src/configuration-common.ts'
import {
  decodeConfigurationSignallingServerFrame,
  encodeConfigurationSignallingClientFrame,
  type ConfigurationSignallingServerFrame,
} from '../../../farm-protocol/src/configuration-signalling.ts'
import { ConnectorIdentity } from '../identity/store.ts'
import type { ConfigurationRuntime } from '../runtime/configuration.ts'
import { ConfigurationConnectorPeer } from './configuration-peer.ts'
import type { ConfigurationConnectorSession } from './configuration-session.ts'

export const CONFIGURATION_SIGNALLING_PATH = '/api/signalling/config-connector'
export const CONFIGURATION_SIGNALLING_SUBPROTOCOL =
  'open3dfarm.config-signalling.v1'
const MAX_SOCKET_BYTES = 12_288
const MAX_IGNORED_CANDIDATES = 64
/** Fixed processing stages reported when an inbound frame stops the link. */
type FrameStage =
  | 'frame-shape'
  | 'frame-decode'
  | 'frame-handle'
  | 'context-scope'
  | 'context-window'
  | 'context-peer'
  | 'context-session'
  | 'context-offer'
  | 'context-send'
const ERROR_CATEGORIES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
])
/** Category only: never the message, stack or any value carried by the error. */
function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error'
  return ERROR_CATEGORIES.has(error.name) ? error.name : 'other-error'
}

export interface ConfigurationSocket {
  send(wire: string): void
  close(): void
  bind(handlers: { message(raw: unknown): void; close(): void }): void
}
export interface ConfigurationPeerLike {
  readonly session: ConfigurationConnectorSession
  readonly closed: Promise<void>
  offer(): Promise<string>
  answer(sdp: string): void
  close(reason?: string): void
}
export type ConfigurationPeerFactory = (input: {
  bindAddress?: string
  session: (send: (wire: string) => void) => ConfigurationConnectorSession
  binding: Promise<unknown>
}) => ConfigurationPeerLike

export interface ConfigurationSignallingOptions {
  identity: ConnectorIdentity
  farmOrigin: string
  credentialAudience: string
  farmId: string
  agentId: string
  credential: () => { token: string; jti: string } | null
  /** Resolved lazily: the runtime reads `online()` from this client. */
  runtime: () => ConfigurationRuntime
  socket: () => Promise<ConfigurationSocket>
  peer?: ConfigurationPeerFactory
  bindAddress?: string
  clock?: () => number
  retryMinMs?: number
  retryMaxMs?: number
  onDiagnostic?: (event: Readonly<Record<string, unknown>>) => void
}

interface Context {
  transportId: string
  peer: ConfigurationPeerLike
  seq: number
  /** Trickle candidates seen for this context (bounded like the server relay). */
  ice: number
  resolveBinding: (value: unknown) => void
  rejectBinding: (error: Error) => void
  bound: boolean
}

const defaultPeer: ConfigurationPeerFactory = (input) =>
  new ConfigurationConnectorPeer(input)

/**
 * Connector side of the dedicated config-v1 signalling socket: credential
 * proof, local enablement advertisement, then one RTC context at a time. Only
 * rtc.* frames are relayed; no configuration action ever crosses the server.
 */
export function createConfigurationSignallingClient(
  options: ConfigurationSignallingOptions,
) {
  if (!(options.identity instanceof ConnectorIdentity))
    throw new Error('Owned Connector identity required')
  const clock = options.clock ?? Date.now
  const identity = options.identity
  const jwk = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  }).export({ format: 'jwk' })
  const thumbprint = createHash('sha256')
    .update(canonicalize({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))
    .digest('base64url')
  const peerFactory = options.peer ?? defaultPeer
  const report = (event: Readonly<Record<string, unknown>>) => {
    try {
      const pending: unknown = options.onDiagnostic?.(event)
      if (pending instanceof Promise) pending.catch(() => {})
    } catch {
      /* Observational only. */
    }
  }
  let online = false

  async function connection(signal: AbortSignal): Promise<boolean> {
    const credential = options.credential()
    if (!credential) return false
    const socket = await options.socket()
    let phase: 'begin' | 'proof' | 'ready' = 'begin'
    let retries = 0
    let context: Context | null = null
    let leaseTimer: ReturnType<typeof setTimeout> | undefined
    let readied = false
    let stage: FrameStage = 'frame-shape'
    let finished: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      finished = resolve
    })
    const send = (frame: unknown) =>
      socket.send(encodeConfigurationSignallingClientFrame(frame))
    const begin = () =>
      send({
        v: 1,
        t: 'config.connector-begin',
        farm_id: options.farmId,
        agent_id: options.agentId,
        jti: credential.jti,
        token: credential.token,
      })

    function closeContext(reason: string) {
      const current = context
      context = null
      if (!current) return
      current.rejectBinding(new Error(reason))
      current.peer.close(reason)
    }
    let stopped = false
    function stop() {
      if (stopped) return
      stopped = true
      clearTimeout(leaseTimer)
      if (online) options.runtime().revokeAll()
      online = false
      closeContext('signalling-closed')
      try {
        socket.close()
      } catch {
        /* Already closed. */
      }
      finished()
    }
    const onAbort = () => stop()
    signal.addEventListener('abort', onAbort, { once: true })

    function validChallenge(
      frame: Extract<
        ConfigurationSignallingServerFrame,
        { t: 'config.connector-challenge' }
      >,
    ): string | null {
      const c = frame.challenge
      const now = clock()
      if (
        c.agent_id !== options.agentId ||
        c.farm_id !== options.farmId ||
        c.jti !== credential!.jti ||
        c.purpose !== 'signalling' ||
        c.origin !== options.farmOrigin ||
        c.audience !== options.credentialAudience ||
        c.public_key_spki !== identity.publicKeySpki ||
        c.fingerprint !== identity.fingerprint ||
        c.thumbprint !== thumbprint ||
        now < c.issued_at ||
        now >= c.expires_at
      )
        return null
      return identity.signCredentialProof({
        challenge: c,
        token: credential!.token,
        expectedOrigin: options.farmOrigin,
        expectedAudience: options.credentialAudience,
        expectedPurpose: 'signalling',
        expectedConnectionId: c.connection_id,
        now,
      })
    }

    async function openContext(
      frame: Extract<
        ConfigurationSignallingServerFrame,
        { t: 'config.context-request' }
      >,
    ) {
      stage = 'context-scope'
      if (
        frame.farm_id !== options.farmId ||
        frame.agent_id !== options.agentId
      )
        throw new Error('Foreign configuration context')
      stage = 'context-window'
      if (clock() < frame.issued_at || clock() >= frame.expires_at)
        throw new Error('Foreign configuration context')
      closeContext('superseded')
      let resolveBinding: (value: unknown) => void = () => {}
      let rejectBinding: (error: Error) => void = () => {}
      const binding = new Promise<unknown>((resolve, reject) => {
        resolveBinding = resolve
        rejectBinding = reject
      })
      binding.catch(() => {})
      stage = 'context-session'
      const runtime = options.runtime()
      stage = 'context-peer'
      const peer = peerFactory({
        ...(options.bindAddress ? { bindAddress: options.bindAddress } : {}),
        binding,
        session: (sendWire) => {
          stage = 'context-session'
          const session = runtime.openSession({
            expected: {
              transportId: frame.transport_id,
              farmId: frame.farm_id,
              agentId: frame.agent_id,
              accountId: frame.account_id,
              keyId: frame.key_id,
              browserThumbprint: frame.browser_thumbprint,
              credentialJti: credential!.jti,
              connectorNonce: frame.connector_nonce,
            },
            send: sendWire,
          })
          stage = 'context-peer'
          return session
        },
      })
      const current: Context = {
        transportId: frame.transport_id,
        peer,
        seq: 0,
        ice: 0,
        resolveBinding,
        rejectBinding,
        bound: false,
      }
      context = current
      void peer.closed.then(() => {
        if (context === current) context = null
      })
      stage = 'context-offer'
      const sdp = await peer.offer()
      if (context !== current) return
      stage = 'context-send'
      send({
        v: 1,
        t: 'rtc.offer',
        transport_id: current.transportId,
        seq: current.seq++,
        p: { sdp },
      })
    }

    async function handle(frame: ConfigurationSignallingServerFrame) {
      switch (frame.t) {
        case 'config.retry':
          if (phase !== 'begin' || ++retries > 2) throw new Error('Busy')
          setTimeout(() => {
            if (!signal.aborted) begin()
          }, frame.retry_after_ms)
          return
        case 'config.connector-challenge': {
          if (phase !== 'begin') throw new Error('Unexpected challenge')
          const signature = validChallenge(frame)
          if (!signature) throw new Error('Untrusted challenge')
          phase = 'proof'
          send({ v: 1, t: 'config.connector-proof', signature })
          return
        }
        case 'config.connector-ready': {
          if (phase !== 'proof') throw new Error('Unexpected ready')
          const now = clock()
          if (now < frame.issued_at - 5000 || now >= frame.expires_at)
            throw new Error('Stale inbox lease')
          phase = 'ready'
          const revision = options.runtime().revision()
          if (revision === null) throw new Error('Journal unavailable')
          send({
            v: 1,
            t: 'config.advertise',
            protocol: CONFIGURATION_PROTOCOL,
            enabled: true,
            revision,
          })
          online = true
          readied = true
          report({ kind: 'configuration-signalling', state: 'ready' })
          leaseTimer = setTimeout(
            () => stop(),
            Math.max(0, frame.expires_at - clock()),
          )
          return
        }
        case 'config.context-request':
          if (phase !== 'ready') throw new Error('Unexpected context')
          return openContext(frame)
        case 'config.binding': {
          const current = context
          if (
            !current ||
            current.bound ||
            frame.binding.transport_id !== current.transportId
          )
            throw new Error('Unexpected binding')
          current.bound = true
          current.resolveBinding(frame.binding)
          return
        }
        case 'config.context-closed':
          if (context?.transportId === frame.transport_id)
            closeContext('context-closed')
          return
        case 'rtc.answer':
          if (!context || frame.transport_id !== context.transportId)
            throw new Error('Foreign answer')
          context.peer.answer(frame.p.sdp)
          return
        case 'rtc.close':
          if (context?.transportId === frame.transport_id)
            closeContext('rtc-closed')
          return
        case 'rtc.ice':
          // Trickle is deliberately not consumed. The Connector offer is sent
          // only after ICE gathering completed (every candidate is inside the
          // SDP the binding pins, and node-datachannel gets no ICE servers),
          // and the browser must answer with its complete SDP: the binding
          // hashes both descriptions and the peer closes on any description
          // change, so a late candidate cannot be applied without breaking
          // that pin. Candidates are counted (server relays at most 64 per
          // direction), never forwarded to the peer, and reported once.
          if (!context || frame.transport_id !== context.transportId)
            throw new Error('Foreign candidate')
          if (++context.ice > MAX_IGNORED_CANDIDATES)
            throw new Error('Candidate limit')
          if (context.ice === 1)
            report({ kind: 'configuration-signalling', state: 'ice-ignored' })
          return
        default:
          throw new Error('Unexpected configuration signalling frame')
      }
    }

    let chain = Promise.resolve()
    socket.bind({
      message(raw) {
        chain = chain
          .then(async () => {
            let kind: string | null = null
            try {
              stage = 'frame-shape'
              if (typeof raw !== 'string' || raw.length > MAX_SOCKET_BYTES)
                throw new Error('Invalid frame')
              stage = 'frame-decode'
              const frame = decodeConfigurationSignallingServerFrame(raw)
              kind = frame.t
              stage = 'frame-handle'
              await handle(frame)
            } catch (error) {
              report({
                kind: 'configuration-signalling',
                state: 'frame-failed',
                stage,
                frame: kind,
                error: errorCategory(error),
              })
              throw error
            }
          })
          .catch(() => stop())
      },
      close: () => stop(),
    })
    try {
      begin()
    } catch {
      stop()
    }
    await done
    signal.removeEventListener('abort', onAbort)
    return readied
  }

  return Object.freeze({
    online: () => online,
    /** Reconnects with bounded backoff until aborted. */
    async run(signal: AbortSignal): Promise<void> {
      const min = options.retryMinMs ?? 1000
      const max = options.retryMaxMs ?? 30_000
      let delay = min
      while (!signal.aborted) {
        let readied = false
        try {
          readied = await connection(signal)
        } catch {
          readied = false
        }
        if (signal.aborted) break
        delay = readied ? min : Math.min(max, delay * 2)
        report({ kind: 'configuration-signalling', state: 'reconnecting' })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      }
    },
  })
}

type WsConstructor = new (
  url: URL,
  protocol: string,
  options: Record<string, unknown>,
) => {
  readyState: number
  send(data: string, done: (error?: Error) => void): void
  close(): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** Real `ws` socket to the exact config-connector endpoint of the pinned origin. */
export async function configurationConnectorSocket(
  farmOrigin: string,
  load: () => Promise<{ WebSocket: unknown }> = () => import('ws'),
): Promise<ConfigurationSocket> {
  const origin = new URL(farmOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== farmOrigin)
    throw new Error('Invalid configuration signalling origin')
  const target = new URL(`wss://${origin.host}${CONFIGURATION_SIGNALLING_PATH}`)
  const module = await load()
  const WebSocket = module.WebSocket as WsConstructor
  const socket = new WebSocket(target, CONFIGURATION_SIGNALLING_SUBPROTOCOL, {
    rejectUnauthorized: true,
    maxPayload: MAX_SOCKET_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
    skipUTF8Validation: false,
  })
  socket.on('error', () => {})
  const pending: string[] = []
  socket.on('open', () => {
    for (const wire of pending.splice(0)) socket.send(wire, () => {})
  })
  return {
    send(wire) {
      if (socket.readyState === 1) socket.send(wire, () => {})
      else if (socket.readyState === 0 && pending.length < 4) pending.push(wire)
      else throw new Error('Configuration socket closed')
    },
    close: () => socket.close(),
    bind(handlers) {
      socket.on('message', (data: unknown, binary: unknown) => {
        handlers.message(binary === false ? String(data) : null)
      })
      socket.on('close', () => handlers.close())
    },
  }
}
