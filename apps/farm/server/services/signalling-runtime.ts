import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { SessionConfig } from 'nuxt/server'
import {
  decodeSignallingClientFrame,
  encodeSignallingServerFrame,
  type SignallingClientControl,
  type SignallingServerFrame,
} from '../../../../packages/farm-protocol/src/signalling-socket.ts'
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
import {
  SignallingCoordinator,
  type SignallingEndpoint,
  type SignallingHandle,
} from './signalling-coordinator.ts'
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
  browserHandle: SignallingHandle
  connectorHandle: SignallingHandle | null
  lifetime: { expiresAt: number; monotonicDeadline: number }
}
type State =
  | { kind: 'browser.begin'; sessionId: string }
  | { kind: 'browser.proof'; handle: SignallingHandle }
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
      handle: SignallingHandle
    }
  | {
      kind: 'connector.active'
      identity: Identity
      link: Link
      handle: SignallingHandle
    }
interface Connection {
  readonly request: IncomingMessage
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
  readonly #inboxes = new Map<string, Connection>()
  #closed = false
  constructor(input: {
    reader: Reader
    credentials: Credentials
    origin: string
    cookie: SessionConfig
    clock?: SignallingClock
  }) {
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
  ): Promise<Response | void> {
    let connection: Connection | undefined
    try {
      if (this.#closed) throw new Error('Closed')
      const inspected = inspectSignallingUpgrade(input, role, this.#origin)
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
          signallingBrowserSession(input, this.#origin, this.#cookie),
        )
        if (!result.ok || owned.closed) throw new Error('Session denied')
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
        this.#closed
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
  close(): void {
    this.#closed = true
    this.#coordinator.dispose()
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
  #send(connection: Connection, frame: SignallingServerFrame): void {
    if (
      connection.closed ||
      !this.#resources.send(
        connection.resource,
        encodeSignallingServerFrame(frame),
      )
    )
      throw new Error('Closed signalling send')
  }
  #endpoint(connection: Connection): SignallingEndpoint {
    return {
      armDeadline: (remaining, expired) => {
        if (connection.closed) throw new Error('Closed endpoint')
        return after(remaining, () => {
          expired()
          this.#close(connection)
        })
      },
      send: (wire) => {
        // Coordinator accepts only strict RTC metadata; no other network frame is forwarded.
        if (!this.#resources.send(connection.resource, wire))
          throw new Error('Relay unavailable')
      },
      bindReadOnly: (binding) =>
        this.#send(connection, { v: 1, t: 'rtc.binding', binding }),
      close: () => this.#close(connection),
    }
  }
  async #process(connection: Connection, wire: string): Promise<void> {
    if (connection.closed || this.#closed) return
    const frame = decodeSignallingClientFrame(wire)
    if (frame.t.startsWith('rtc.')) {
      const state = connection.state
      const handle =
        state.kind === 'browser.active'
          ? state.link.browserHandle
          : state.kind === 'connector.active'
            ? state.handle
            : null
      if (!handle || !(await this.#coordinator.receiveAndWait(handle, wire)))
        throw new Error('Relay denied')
      return
    }
    // The switch is explicit: an authenticated machine cannot act as a browser.
    const control = signallingControl(frame)
    switch (control.t) {
      case 'browser.begin': {
        if (connection.state.kind !== 'browser.begin')
          throw new Error('Admission order')
        const opened = await this.#coordinator.open(
          {
            sessionRecordId: connection.state.sessionId,
            farmId: control.farm_id,
            agentId: control.agent_id,
            keyId: control.key_id,
          },
          this.#endpoint(connection),
        )
        if (!opened || connection.closed) throw new Error('Browser denied')
        connection.state = { kind: 'browser.proof', handle: opened.handle }
        this.#send(connection, {
          v: 1,
          t: 'browser.challenge',
          challenge: opened.challenge,
        })
        break
      }
      case 'browser.proof': {
        if (connection.state.kind !== 'browser.proof')
          throw new Error('Proof order')
        const handle = connection.state.handle
        if (
          !(await this.#coordinator.prove(handle, control.signature)) ||
          connection.closed
        )
          throw new Error('Browser proof denied')
        const description = this.#coordinator.describe(handle)
        if (!description) throw new Error('Expired')
        const inbox = this.#inboxes.get(description.agentId)
        if (!inbox || inbox.closed || inbox.state.kind !== 'connector.ready')
          throw new Error('Connector unavailable')
        const current = await this.#current(inbox, inbox.state.identity)
        if (
          !current ||
          connection.closed ||
          inbox.closed ||
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
          t: 'connector.context-request',
          transport_id: description.transportId,
          issued_at: description.issuedAt,
          expires_at: Math.min(
            description.admissionExpiresAt,
            inbox.inboxExpiresAt,
          ),
          commands_enabled: false,
        })
        break
      }
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
          this.#inboxes.has(current.identity.agent_id)
        )
          throw new Error('Inbox proof expired')
        connection.state = { kind: 'connector.ready', identity: current }
        this.#inboxes.set(current.identity.agent_id, connection)
        if (!this.#resources.finishPreauth(connection.resource))
          throw new Error('Expired inbox admission')
        this.#send(connection, {
          v: 1,
          t: 'connector.inbox-ready',
          inbox_id: connection.inboxId,
          issued_at: current.budget.observedAt,
          expires_at: connection.inboxExpiresAt,
          commands_enabled: false,
        })
        this.#revalidation(connection)
        break
      }
      case 'connector.attach': {
        const state = connection.state
        if (state.kind !== 'connector.request') throw new Error('Context order')
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
      case 'connector.context-proof': {
        const state = connection.state
        if (state.kind !== 'connector.context-proof')
          throw new Error('Context proof order')
        if (
          !(await this.#coordinator.prove(state.handle, control.signature)) ||
          connection.closed ||
          state.link.browser.closed
        )
          throw new Error('Context denied')
        const description = this.#coordinator.describe(state.handle)
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
          t: 'rtc.ready',
          transport_id: description.transportId,
          issued_at: description.issuedAt,
          expires_at: description.expiresAt,
          commands_enabled: false,
        } satisfies SignallingServerFrame
        this.#send(state.link.browser, ready)
        this.#send(connection, ready)
        break
      }
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
        t: 'retry',
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
    this.#send(connection, { v: 1, t: 'connector.inbox-challenge', challenge })
  }
  async #attach(connection: Connection): Promise<void> {
    const state = connection.state
    if (state.kind !== 'connector.attach') throw new Error('Attach order')
    const attached = await this.#coordinator.attachConnector(
      state.link.browserHandle,
      this.#endpoint(connection),
      state.token,
      state.link.lifetime,
    )
    if (connection.closed) return
    if (attached?.kind === 'busy') {
      state.retryAt = this.#clock.monotonic() + attached.retryAfterMs
      this.#send(connection, {
        v: 1,
        t: 'retry',
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
    state.link.connectorHandle = attached.handle
    connection.state = {
      kind: 'connector.context-proof',
      identity: state.identity,
      link: state.link,
      handle: attached.handle,
    }
    this.#send(connection, {
      v: 1,
      t: 'connector.context-challenge',
      challenge: attached.challenge,
    })
  }
  #observeClock(connection: Connection): SignallingClockSample {
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
          this.#close(connection)
          return
        }
        // Never overwrite a later state established by a concurrently awaited proof.
        if (connection.state === state) state.identity = current
        this.#revalidation(connection)
      })
    })
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
      this.#inboxes.get(state.identity.identity.agent_id) === connection
    )
      this.#inboxes.delete(state.identity.identity.agent_id)
    if (state.kind === 'browser.proof')
      this.#coordinator.disconnect(state.handle)
    if ('link' in state) {
      this.#coordinator.disconnect(state.link.browserHandle)
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
function signallingControl(
  input: ReturnType<typeof decodeSignallingClientFrame>,
): SignallingClientControl {
  if (
    input.t === 'rtc.offer' ||
    input.t === 'rtc.answer' ||
    input.t === 'rtc.ice' ||
    input.t === 'rtc.close'
  )
    throw new Error('Unexpected RTC metadata')
  return input
}
