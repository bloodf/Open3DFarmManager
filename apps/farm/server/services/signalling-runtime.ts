import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { SessionConfig } from 'nuxt/server'
import {
  decodeSignallingClientFrame,
  encodeSignallingServerFrame,
  SignallingServerFrame,
} from '../../../../packages/farm-protocol/src/signalling-socket.ts'
import {
  decodePauseSignallingClientFrame,
  encodePauseSignallingServerFrame,
  type PauseSignallingServerFrame,
} from '../../../../packages/farm-protocol/src/pause-signalling.ts'
import { PauseSignallingCoordinator } from './pause-signalling-coordinator.ts'
import {
  DISABLED_SIGNALLING_METADATA,
  validatedSignallingMetadata,
  type SignallingMetadata,
} from './signalling-metadata.ts'
import type { PauseNegotiationRuntime } from '../utils/pause-authority/runtime.ts'
import {
  openPauseNegotiation,
  openReadOnlyNegotiation,
  type NegotiationContext,
  type NegotiationPeer,
  type NegotiationDescription,
  type SignallingMetadataPort,
  type SignallingMode,
} from './signalling-negotiation-adapter.ts'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import type {
  CredentialProofChallenge,
  CredentialProofRequest,
} from '../../../../packages/farm-protocol/src/credential-proof.ts'
import type { PostgresConnectorCredentialAcceptance } from '../storage/postgres-connector-credential-acceptance.ts'
import type {
  PostgresSignallingAuthorization,
  ConnectorCurrentSnapshot,
} from '../storage/postgres-signalling-authorization.ts'
import { acceptSignallingProof } from './signalling-proof-acceptance.ts'
import { SignallingCoordinator } from './signalling-coordinator.ts'
import {
  signallingClockSample,
  signallingRemaining,
  type SignallingClock,
  type SignallingClockSample,
} from './signalling-clock.ts'
import {
  inspectSignallingUpgrade,
  signallingBrowserSession,
  signallingNodeUpgrade,
  type SignallingSocketRole,
} from './signalling-websocket-boundary.ts'
import {
  SignallingWebSocketResources,
  type SignallingResourceHandle,
  type SignallingSocketPort,
} from './signalling-websocket-limits.ts'
import {
  destroySignallingUpgrade,
  signallingNativeSocket,
  signallingMessageText,
} from './signalling-socket.ts'

type Reader = Pick<
  PostgresSignallingAuthorization,
  'read' | 'readConnectorCurrent'
>
type Credentials = Pick<
  PostgresConnectorCredentialAcceptance,
  'issue' | 'accept'
>
type Identity = ConnectorCurrentSnapshot
type Link = {
  browser: Connection
  connector: Connection
  browserHandle: NegotiationContext
  connectorHandle: NegotiationPeer | null
  lifetime: { expiresAt: number; monotonicDeadline: number }
}
type State =
  | { kind: 'browser.begin'; sessionId: string }
  | { kind: 'browser.proof'; handle: NegotiationContext }
  | { kind: 'browser.wait'; link: Link }
  | { kind: 'browser.active'; link: Link }
  | { kind: 'connector.begin' }
  | {
      kind: 'connector.issue'
      request: CredentialProofRequest
      identity: Identity
      retryAt: number
    }
  | {
      kind: 'connector.proof'
      request: CredentialProofRequest
      identity: Identity
      challenge: CredentialProofChallenge
    }
  | { kind: 'connector.ready'; identity: Identity }
  | { kind: 'connector.request'; identity: Identity; link: Link }
  | {
      kind: 'connector.attach'
      identity: Identity
      link: Link
      token: string
      retryAt: number
    }
  | {
      kind: 'connector.context-proof'
      identity: Identity
      link: Link
      handle: NegotiationPeer
    }
  | {
      kind: 'connector.active'
      identity: Identity
      link: Link
      handle: NegotiationPeer
    }
interface Connection {
  readonly request: IncomingMessage
  readonly mode: SignallingMode
  readonly pause: PauseOwner | undefined
  readonly resource: SignallingResourceHandle
  readonly start: SignallingClockSample
  lastSample: SignallingClockSample
  readonly inboxId: string
  inboxGeneration: number
  state: State
  native: SignallingSocketPort | null
  closed: boolean
  readonly abort: AbortController
  inboxDeadline: number
  inboxExpiresAt: number
  authorityCancel: (() => void) | null
  revalidationCancel: (() => void) | null
  removeSocketClose: () => void
}
type PauseOwner = Readonly<{
  facade: PauseNegotiationRuntime
  coordinator: PauseSignallingCoordinator
  detach(): void
}>
type PauseConfiguration = Readonly<{
  current(): PauseNegotiationRuntime | undefined
  databaseIdentity: PauseNegotiationRuntime['databaseIdentity']
  credentialIssuer: string
  credentialAudience: string
}>
function inboxKey(connection: Connection, agentId: string): string {
  return connection.mode + ':' + agentId
}
function pauseScope(description: NegotiationDescription) {
  if (description.mode !== 'pause') throw Error('Pause context required')
  return {
    transport_id: description.transportId,
    farm_id: description.farmId,
    agent_id: description.agentId,
    assignment_id: description.assignmentId,
  }
}
const defaultClock: SignallingClock = {
  wall: Date.now,
  monotonic: () => performance.now(),
}
const after = (ms: number, callback: () => void) => {
  const timer = setTimeout(callback, Math.max(0, ms))
  timer.unref()
  return () => clearTimeout(timer)
}
function identityPins(value: Identity): string {
  const { validUntil: _, ...identity } = value.identity
  return canonicalize(identity)
}
/** A server-owned ephemeral rendezvous. Neither a JWT nor an in-memory receipt
 * admits a later operation: relay authorization is reread through the coordinator.
 * All authority disappears on restart or socket loss. No command/media relay. */
export class SignallingRuntime {
  readonly #reader: Reader
  readonly #credentials: Credentials
  readonly #origin: string
  readonly #cookie: SessionConfig
  readonly #clock: SignallingClock
  readonly #resources: SignallingWebSocketResources
  readonly #coordinator: SignallingCoordinator
  readonly #connections = new Map<IncomingMessage, Connection>()
  /** Strictly increasing confirmation sequence, anchored to database time. */
  #authoritySeq = 0
  readonly #inboxes = new Map<string, Connection>()
  #closed = false
  readonly #pauseConfig: PauseConfiguration | undefined
  #pauseOwner: PauseOwner | undefined
  constructor(input: {
    reader: Reader
    credentials: Credentials
    origin: string
    cookie: SessionConfig
    clock?: SignallingClock
    pause?: PauseConfiguration
  }) {
    this.#pauseConfig = input.pause
      ? Object.freeze({
          ...input.pause,
          databaseIdentity: Object.freeze({ ...input.pause.databaseIdentity }),
        })
      : undefined
    this.#reader = input.reader
    this.#credentials = input.credentials
    this.#origin = input.origin
    this.#cookie = input.cookie
    this.#clock = input.clock ?? defaultClock
    this.#resources = new SignallingWebSocketResources({
      now: () => this.#clock.monotonic(),
      after,
    })
    this.#coordinator = new SignallingCoordinator(
      input.reader,
      input.credentials,
      this.#clock,
      { after },
    )
  }
  async upgrade(
    input: unknown,
    role: SignallingSocketRole,
    mode: SignallingMode = 'read-only',
  ): Promise<Response | void> {
    let connection: Connection | undefined
    try {
      if (this.#closed) throw new Error('Closed')
      const pause = mode === 'pause' ? this.#pauseAdmission() : undefined
      const inspected = inspectSignallingUpgrade(
        input,
        role,
        this.#origin,
        mode,
      )
      const request = inspected.request
      const start = signallingClockSample(this.#clock)
      const resource = this.#resources.reserve({
        bufferedAmount: () => connection?.native?.bufferedAmount() ?? 0,
        send: (text) => {
          if (
            !connection?.native ||
            connection.closed ||
            request.socket.destroyed
          )
            throw new Error('Socket unavailable')
          connection.native.send(text)
        },
        terminate: () => {
          if (connection) this.#close(connection)
          else request.socket.destroy()
        },
      })
      if (!resource || request.socket.destroyed) throw new Error('Capacity')
      connection = {
        request,
        mode,
        pause,
        resource,
        start,
        lastSample: start,
        inboxId: randomUUID(),
        inboxGeneration: 0,
        state:
          role === 'browser'
            ? { kind: 'browser.begin', sessionId: '' }
            : { kind: 'connector.begin' },
        native: null,
        closed: false,
        abort: new AbortController(),
        inboxDeadline: start.monotonic + 30_000,
        inboxExpiresAt: Number.MAX_SAFE_INTEGER,
        authorityCancel: null,
        revalidationCancel: null,
        removeSocketClose: () => {},
      }
      const owned = connection
      this.#connections.set(request, owned)
      const close = () => this.#close(owned)
      request.socket.once('close', close)
      owned.removeSocketClose = () =>
        request.socket.removeListener('close', close)
      if (role === 'browser') {
        const result = await this.#resources.work(resource, () =>
          signallingBrowserSession(input, this.#origin, this.#cookie, mode),
        )
        if (!result.ok || owned.closed || !this.#owned(owned))
          throw new Error('Session denied')
        owned.state = {
          kind: 'browser.begin',
          sessionId: result.value.sessionRecordId,
        }
      }
    } catch {
      if (connection) this.#close(connection)
      destroySignallingUpgrade(input)
      return new Response(null, { status: 403 })
    }
  }
  open(peer: unknown): void {
    let connection: Connection | undefined
    try {
      // Guard and native ping/binary policy run synchronously before any await.
      const native = signallingNativeSocket(peer, () => {
        if (connection) this.#close(connection)
      })
      connection = this.#connections.get(native.request)
      if (
        !connection ||
        connection.closed ||
        native.request.socket.destroyed ||
        this.#closed ||
        !this.#owned(connection)
      ) {
        native.port.terminate()
        return
      }
      connection.native = native.port
    } catch {
      if (connection) this.#close(connection)
      this.disconnected(peer)
    }
  }
  message(peer: unknown, message: unknown): void {
    const connection = this.#connection(peer)
    if (!connection || connection.closed) return
    if (connection.request.socket.destroyed) {
      this.#close(connection)
      return
    }
    try {
      const text = signallingMessageText(message)
      this.#resources.receive(connection.resource, text, async (wire) => {
        this.#observeClock(connection)
        await this.#process(connection, wire)
        if (!connection.closed) this.#observeClock(connection)
      })
    } catch {
      this.#close(connection)
    }
  }
  disconnected(peer: unknown): void {
    const connection = this.#connection(peer)
    if (connection) this.#close(connection)
  }
  /** Local terminal state only; exposes neither authority nor connection details. */
  get isClosed(): boolean {
    return this.#closed
  }
  /** Advisory public fields only. This does not allocate or admit a peer. */
  pauseMetadata(): SignallingMetadata {
    try {
      const facade = this.#matchingPauseFacade()
      if (!facade) return DISABLED_SIGNALLING_METADATA
      const metadata = validatedSignallingMetadata(facade)
      return this.#matchingPauseFacade() === facade
        ? metadata
        : DISABLED_SIGNALLING_METADATA
    } catch {
      return DISABLED_SIGNALLING_METADATA
    }
  }
  close(): void {
    this.#closed = true
    this.#coordinator.dispose()
    this.#pauseOwner?.detach()
    this.#pauseOwner?.coordinator.dispose()
    this.#pauseOwner = undefined
    for (const connection of this.#connections.values()) this.#close(connection)
    this.#resources.dispose()
    this.#inboxes.clear()
  }
  #connection(peer: unknown): Connection | undefined {
    try {
      if (!peer || typeof peer !== 'object' || !('request' in peer))
        return undefined
      return this.#connections.get(signallingNodeUpgrade(peer.request))
    } catch {
      return undefined
    }
  }
  #matchingPauseFacade(): PauseNegotiationRuntime | undefined {
    const config = this.#pauseConfig,
      facade = config?.current()
    if (
      this.#closed ||
      !config ||
      !facade ||
      facade.signal.aborted ||
      facade.origin !== this.#origin ||
      facade.credentialIssuer !== config.credentialIssuer ||
      facade.credentialAudience !== config.credentialAudience ||
      facade.databaseIdentity.database !== config.databaseIdentity.database ||
      facade.databaseIdentity.address !== config.databaseIdentity.address ||
      facade.databaseIdentity.port !== config.databaseIdentity.port
    )
      return undefined
    return facade
  }
  #pauseAdmission(): PauseOwner {
    const facade = this.#matchingPauseFacade()
    const config = this.#pauseConfig
    if (!facade || !config) throw Error('Pause runtime unavailable')
    if (this.#pauseOwner?.facade === facade) return this.#pauseOwner
    if (this.#pauseOwner) this.#retirePause(this.#pauseOwner)
    const coordinator = new PauseSignallingCoordinator({
      authority: facade.reader,
      credentials: this.#credentials,
      credentialAudience: config.credentialAudience,
      clock: this.#clock,
      timers: { after },
    })
    const abort = () => this.#retirePause(owner)
    const owner: PauseOwner = Object.freeze({
      facade,
      coordinator,
      detach: () => facade.signal.removeEventListener('abort', abort),
    })
    this.#pauseOwner = owner
    facade.signal.addEventListener('abort', abort, { once: true })
    if (facade.signal.aborted || config.current() !== facade) {
      this.#retirePause(owner)
      throw Error('Pause runtime changed')
    }
    return owner
  }
  #retirePause(owner: PauseOwner): void {
    owner.detach()
    if (this.#pauseOwner === owner) this.#pauseOwner = undefined
    owner.coordinator.dispose()
    for (const connection of this.#connections.values())
      if (connection.pause === owner) this.#close(connection)
  }
  #owned(connection: Connection): boolean {
    if (this.#closed || connection.closed) return false
    if (connection.mode === 'read-only') return true
    const owner = connection.pause
    if (
      !owner ||
      owner.facade.signal.aborted ||
      this.#pauseConfig?.current() !== owner.facade ||
      this.#pauseOwner !== owner
    ) {
      this.#close(connection)
      return false
    }
    return true
  }
  #wire(connection: Connection, wire: string): void {
    if (
      !this.#owned(connection) ||
      !this.#resources.send(connection.resource, wire)
    )
      throw Error('Closed signalling send')
  }
  #send(
    connection: Connection,
    frame: SignallingServerFrame | PauseSignallingServerFrame,
  ): void {
    this.#wire(
      connection,
      connection.mode === 'pause'
        ? encodePauseSignallingServerFrame(frame)
        : encodeSignallingServerFrame(SignallingServerFrame.parse(frame)),
    )
  }
  #endpoint(connection: Connection): SignallingMetadataPort {
    return {
      armDeadline: (remaining, expired) => {
        if (!this.#owned(connection)) throw Error('Closed endpoint')
        return after(remaining, () => {
          expired()
          this.#close(connection)
        })
      },
      send: (wire) => this.#wire(connection, wire),
      close: () => this.#close(connection),
    }
  }
  async #process(connection: Connection, wire: string): Promise<void> {
    if (!this.#owned(connection)) return
    const frame =
      connection.mode === 'pause'
        ? decodePauseSignallingClientFrame(wire)
        : decodeSignallingClientFrame(wire)
    if (frame.t.startsWith('rtc.')) {
      const state = connection.state
      const handle =
        state.kind === 'browser.active'
          ? state.link.browserHandle
          : state.kind === 'connector.active'
            ? state.handle
            : null
      if (!handle || !(await handle.relay(wire)))
        throw new Error('Relay denied')
      return
    }
    // The switch is explicit: an authenticated machine cannot act as a browser.
    const control = frame
    switch (control.t) {
      case 'pause.begin':
      case 'browser.begin': {
        if (connection.state.kind !== 'browser.begin')
          throw new Error('Admission order')
        const scope = {
          sessionRecordId: connection.state.sessionId,
          farmId: control.farm_id,
          agentId: control.agent_id,
          keyId: control.key_id,
        }
        const opened =
          control.t === 'pause.begin'
            ? await openPauseNegotiation(
                connection.pause!.coordinator,
                { ...scope, assignmentId: control.assignment_id },
                this.#endpoint(connection),
              )
            : await openReadOnlyNegotiation(
                this.#coordinator,
                scope,
                this.#endpoint(connection),
              )
        if (!opened || !this.#owned(connection)) {
          opened?.context.close()
          throw Error('Browser denied')
        }
        connection.state = { kind: 'browser.proof', handle: opened.context }
        this.#wire(connection, opened.challengeWire)
        break
      }
      case 'pause.browser-proof':
      case 'browser.proof': {
        if (connection.state.kind !== 'browser.proof')
          throw new Error('Proof order')
        const handle = connection.state.handle
        if (!(await handle.prove(control.signature)) || connection.closed)
          throw new Error('Browser proof denied')
        const description = handle.describe()
        if (!description || description.mode !== connection.mode)
          throw new Error('Expired')
        const inbox = this.#inboxes.get(
          inboxKey(connection, description.agentId),
        )
        if (!inbox || inbox.closed || inbox.state.kind !== 'connector.ready')
          throw new Error('Connector unavailable')
        const current = await this.#current(inbox, inbox.state.identity)
        if (
          !current ||
          !this.#owned(connection) ||
          !this.#owned(inbox) ||
          inbox.pause !== connection.pause ||
          inbox.state.kind !== 'connector.ready' ||
          current.identity.credential_jti !== description.jti ||
          current.identity.farm_id !== description.farmId
        )
          throw new Error('Connector unavailable')
        const link: Link = {
          browser: connection,
          connector: inbox,
          browserHandle: handle,
          connectorHandle: null,
          lifetime: {
            expiresAt: Math.min(description.expiresAt, inbox.inboxExpiresAt),
            monotonicDeadline: inbox.inboxDeadline,
          },
        }
        connection.state = { kind: 'browser.wait', link }
        inbox.state = { kind: 'connector.request', identity: current, link }
        this.#send(inbox, {
          v: 1,
          ...(description.mode === 'pause'
            ? {
                t: 'pause.context-request' as const,
                ...pauseScope(description),
              }
            : {
                t: 'connector.context-request' as const,
                transport_id: description.transportId,
              }),
          issued_at: description.issuedAt,
          expires_at: Math.min(
            description.admissionExpiresAt,
            inbox.inboxExpiresAt,
          ),
          commands_enabled: false,
        })
        break
      }
      case 'pause.connector-begin':
      case 'connector.begin': {
        if (
          connection.state.kind !== 'connector.begin' ||
          this.#inboxes.size >= 16
        )
          throw new Error('Inbox unavailable')
        const current = await this.#reader.readConnectorCurrent({
          agentId: control.agent_id,
          farmId: control.farm_id,
          jti: control.jti,
        })
        if (!current || connection.closed) throw new Error('Connector denied')
        const identity = await this.#current(connection, current)
        if (!identity) throw new Error('Connector denied')
        connection.state = {
          kind: 'connector.issue',
          request: {
            token: control.token,
            agentId: control.agent_id,
            farmId: control.farm_id,
            connectionId: connection.inboxId,
          },
          identity,
          retryAt: 0,
        }
        await this.#issueInbox(connection)
        break
      }
      case 'pause.connector-inbox-proof':
      case 'connector.inbox-proof': {
        const state = connection.state
        if (state.kind !== 'connector.proof')
          throw new Error('Inbox proof order')
        const result = await acceptSignallingProof({
          credentials: this.#credentials,
          clock: this.#clock,
          timers: { after },
          deadline: Math.min(
            connection.start.monotonic + 8000,
            connection.inboxDeadline,
          ),
          signal: connection.abort.signal,
          request: {
            ...state.request,
            challenge: state.challenge,
            signature: control.signature,
          },
        })
        if (
          !result.ok ||
          result.kind !== 'accepted' ||
          result.connectionId !== connection.inboxId ||
          result.jti !== state.identity.identity.credential_jti ||
          result.agentId !== state.request.agentId ||
          result.farmId !== state.request.farmId ||
          result.purpose !== 'signalling'
        )
          throw new Error('Inbox proof denied')
        const current = await this.#current(connection, state.identity)
        if (
          !current ||
          current.budget.observedAt >= state.challenge.expires_at ||
          current.budget.observedAt >= result.expiresAt ||
          connection.closed ||
          this.#inboxes.size >= 16 ||
          this.#inboxes.has(inboxKey(connection, current.identity.agent_id))
        )
          throw new Error('Inbox proof expired')
        connection.state = { kind: 'connector.ready', identity: current }
        this.#inboxes.set(
          inboxKey(connection, current.identity.agent_id),
          connection,
        )
        if (!this.#resources.finishPreauth(connection.resource))
          throw new Error('Expired inbox admission')
        this.#send(connection, {
          v: 1,
          t:
            connection.mode === 'pause'
              ? 'pause.connector-inbox-ready'
              : 'connector.inbox-ready',
          inbox_id: connection.inboxId,
          issued_at: current.budget.observedAt,
          expires_at: connection.inboxExpiresAt,
          commands_enabled: false,
        })
        this.#confirmAuthority(connection, current)
        this.#revalidation(connection)
        break
      }
      case 'pause.connector-attach':
      case 'connector.attach': {
        const state = connection.state
        if (state.kind !== 'connector.request') throw new Error('Context order')
        if (control.t === 'pause.connector-attach') {
          const description = state.link.browserHandle.describe()
          if (
            !description ||
            description.mode !== 'pause' ||
            control.transport_id !== description.transportId ||
            control.farm_id !== description.farmId ||
            control.agent_id !== description.agentId ||
            control.assignment_id !== description.assignmentId
          )
            throw Error('Pause attach scope')
        }
        connection.state = {
          kind: 'connector.attach',
          identity: state.identity,
          link: state.link,
          token: control.token,
          retryAt: 0,
        }
        await this.#attach(connection)
        break
      }
      case 'pause.connector-context-proof':
      case 'connector.context-proof': {
        const state = connection.state
        if (state.kind !== 'connector.context-proof')
          throw new Error('Context proof order')
        if (
          !(await state.handle.prove(control.signature)) ||
          connection.closed ||
          state.link.browser.closed
        )
          throw new Error('Context denied')
        const description = state.handle.describe()
        if (
          !description ||
          !this.#resources.finishPreauth(state.link.browser.resource)
        )
          throw new Error('Context expired')
        connection.state = {
          kind: 'connector.active',
          identity: state.identity,
          link: state.link,
          handle: state.handle,
        }
        state.link.browser.state = { kind: 'browser.active', link: state.link }
        const ready = {
          v: 1,
          ...(description.mode === 'pause'
            ? { t: 'pause.ready' as const, ...pauseScope(description) }
            : {
                t: 'rtc.ready' as const,
                transport_id: description.transportId,
              }),
          issued_at: description.issuedAt,
          expires_at: description.expiresAt,
          commands_enabled: false,
        } satisfies SignallingServerFrame | PauseSignallingServerFrame
        this.#send(state.link.browser, ready)
        this.#send(connection, ready)
        break
      }
      case 'pause.connector-retry':
      case 'connector.retry': {
        if (connection.state.kind === 'connector.issue') {
          if (this.#clock.monotonic() < connection.state.retryAt)
            throw new Error('Early retry')
          await this.#issueInbox(connection)
        } else if (connection.state.kind === 'connector.attach') {
          if (this.#clock.monotonic() < connection.state.retryAt)
            throw new Error('Early retry')
          await this.#attach(connection)
        } else throw new Error('Retry order')
        break
      }
    }
  }
  async #issueInbox(connection: Connection): Promise<void> {
    const state = connection.state
    if (state.kind !== 'connector.issue') throw new Error('Issue order')
    const result = await this.#credentials.issue(state.request)
    if (connection.closed) return
    if (!result.ok && result.reason === 'busy') {
      state.retryAt = this.#clock.monotonic() + result.retryAfterMs
      this.#send(connection, {
        v: 1,
        t: connection.mode === 'pause' ? 'pause.retry' : 'retry',
        phase: 'inbox',
        retry_after_ms: result.retryAfterMs,
      })
      return
    }
    if (!result.ok || result.kind !== 'challenge')
      throw new Error('Inbox denied')
    const challenge = result.challenge
    const current = await this.#current(connection, state.identity)
    if (
      !current ||
      challenge.connection_id !== connection.inboxId ||
      challenge.agent_id !== current.identity.agent_id ||
      challenge.farm_id !== current.identity.farm_id ||
      challenge.jti !== current.identity.credential_jti ||
      challenge.public_key_spki !==
        current.identity.connector_public_key_spki ||
      challenge.fingerprint !== current.identity.connector_fingerprint ||
      challenge.origin !== this.#origin ||
      challenge.audience !== current.identity.audience ||
      challenge.purpose !== 'signalling' ||
      current.budget.observedAt >= challenge.expires_at
    )
      throw new Error('Inbox challenge denied')
    connection.inboxGeneration = challenge.generation
    connection.state = {
      kind: 'connector.proof',
      request: state.request,
      identity: current,
      challenge,
    }
    this.#send(connection, {
      v: 1,
      t:
        connection.mode === 'pause'
          ? 'pause.connector-inbox-challenge'
          : 'connector.inbox-challenge',
      challenge,
    })
  }
  async #attach(connection: Connection): Promise<void> {
    const state = connection.state
    if (state.kind !== 'connector.attach') throw new Error('Attach order')
    const attached = await state.link.browserHandle.attach(
      this.#endpoint(connection),
      state.token,
      state.link.lifetime,
    )
    if (connection.closed) return
    if (attached?.kind === 'busy') {
      state.retryAt = this.#clock.monotonic() + attached.retryAfterMs
      this.#send(connection, {
        v: 1,
        t: connection.mode === 'pause' ? 'pause.retry' : 'retry',
        phase: 'context',
        retry_after_ms: attached.retryAfterMs,
      })
      return
    }
    if (
      !attached ||
      attached.kind !== 'challenge' ||
      attached.challenge.generation <= connection.inboxGeneration
    )
      throw new Error('Context attach denied')
    state.link.connectorHandle = attached.peer
    connection.state = {
      kind: 'connector.context-proof',
      identity: state.identity,
      link: state.link,
      handle: attached.peer,
    }
    const description = attached.peer.describe()
    if (!description || description.mode !== connection.mode)
      throw Error('Context expired')
    this.#send(connection, {
      v: 1,
      ...(description.mode === 'pause'
        ? { t: 'pause.context-challenge' as const, ...pauseScope(description) }
        : { t: 'connector.context-challenge' as const }),
      challenge: attached.challenge,
    })
  }
  #observeClock(connection: Connection): SignallingClockSample {
    if (!this.#owned(connection)) throw Error('Runtime owner changed')
    const now = signallingClockSample(this.#clock),
      previous = connection.lastSample
    if (
      now.wall < previous.wall ||
      now.monotonic < previous.monotonic ||
      Math.abs(
        now.wall - previous.wall - (now.monotonic - previous.monotonic),
      ) > 250
    )
      throw new Error('Signalling clock discontinuity')
    connection.lastSample = now
    return now
  }
  async #current(
    connection: Connection,
    previous: Identity,
  ): Promise<Identity | null> {
    this.#observeClock(connection)
    const current = await this.#reader.readConnectorCurrent({
      agentId: previous.identity.agent_id,
      farmId: previous.identity.farm_id,
      jti: previous.identity.credential_jti,
    })
    if (
      !current ||
      connection.closed ||
      identityPins(current) !== identityPins(previous) ||
      current.budget.observedAt < previous.budget.observedAt
    )
      return null
    const remaining = signallingRemaining({
      anchor: connection.start,
      now: this.#observeClock(connection),
      authorization: current.budget,
      previousDeadline: connection.inboxDeadline,
    })
    connection.inboxDeadline = remaining.monotonicDeadline
    connection.inboxExpiresAt = Math.min(
      connection.inboxExpiresAt,
      current.identity.validUntil,
      current.budget.observedAt + remaining.remaining,
    )
    if (connection.inboxExpiresAt <= current.budget.observedAt) return null
    connection.authorityCancel?.()
    connection.authorityCancel = after(remaining.remaining, () =>
      this.#close(connection),
    )
    return current
  }
  #revalidation(connection: Connection): void {
    connection.revalidationCancel = after(5000, () => {
      connection.revalidationCancel = null
      const state = connection.state
      if (!('identity' in state) || connection.closed) return
      void this.#resources.work(connection.resource, async () => {
        const current = await this.#current(connection, state.identity)
        if (!current || connection.closed) {
          this.#revokeAuthority(connection)
          this.#close(connection)
          return
        }
        // Never overwrite a later state established by a concurrently awaited proof.
        if (connection.state === state) state.identity = current
        this.#confirmAuthority(connection, current)
        this.#revalidation(connection)
      })
    })
  }
  #nextAuthoritySeq(observedAt: number): number {
    // Database time keeps the floor across restarts and instances. A database
    // clock step backwards only makes the Connector refuse confirms (stale).
    this.#authoritySeq = Math.max(this.#authoritySeq + 1, observedAt * 1000)
    return this.#authoritySeq
  }
  /** Connector inbox only: the current-authority reread just succeeded. */
  #confirmAuthority(connection: Connection, current: Identity): void {
    if (connection.mode !== 'read-only' || connection.closed) return
    this.#send(connection, {
      v: 1,
      t: 'connector.authority-confirm',
      server_seq: this.#nextAuthoritySeq(current.budget.observedAt),
      farm_id: current.identity.farm_id,
      agent_id: current.identity.agent_id,
      credential_jti: current.identity.credential_jti,
    })
  }
  /** A failed reread revokes the Connector's cached authority before closing. */
  #revokeAuthority(connection: Connection): void {
    if (connection.mode !== 'read-only' || connection.closed) return
    try {
      this.#send(connection, {
        v: 1,
        t: 'connector.authority-revoked',
        server_seq: this.#nextAuthoritySeq(this.#clock.wall()),
      })
    } catch {
      // Closing still ends the session; the offline lifetime bounds the rest.
    }
  }
  #close(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
    connection.abort.abort()
    this.#connections.delete(connection.request)
    connection.removeSocketClose()
    connection.authorityCancel?.()
    connection.revalidationCancel?.()
    const state = connection.state
    if (
      'identity' in state &&
      this.#inboxes.get(
        inboxKey(connection, state.identity.identity.agent_id),
      ) === connection
    )
      this.#inboxes.delete(
        inboxKey(connection, state.identity.identity.agent_id),
      )
    if (state.kind === 'browser.proof') state.handle.close()
    if ('link' in state) {
      state.link.browserHandle.close()
      this.#close(state.link.browser)
      this.#close(state.link.connector)
    }
    // Drop any retained JWT from preauthentication/retry state before termination.
    connection.state = { kind: 'connector.begin' }
    this.#resources.close(connection.resource)
    connection.native?.terminate()
    connection.request.socket.destroy()
  }
}
