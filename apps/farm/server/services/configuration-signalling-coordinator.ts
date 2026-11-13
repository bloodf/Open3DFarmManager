import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CredentialProofChallenge } from '../../../../packages/farm-protocol/src/credential-proof.ts'
import { BrowserDeviceUuid } from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  controlDtlsFingerprint,
  controlSdpHash,
} from '../../../../packages/farm-protocol/src/control-session-binding.ts'
import { decodeAuthenticatedSignallingFrame } from '../../../../packages/farm-protocol/src/authenticated-signalling.ts'
import {
  ConfigurationSessionBinding,
  configurationBindingHash,
  validateConfigurationSessionBinding,
} from '../../../../packages/farm-protocol/src/configuration-binding.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'
import type { PostgresConnectorCredentialAcceptance } from '../storage/postgres-connector-credential-acceptance.ts'
import { acceptSignallingProof } from './signalling-proof-acceptance.ts'
import {
  signallingClockSample,
  type SignallingClock,
} from './signalling-clock.ts'
import {
  ConfigurationAuthority,
  ConfigurationScope,
  configurationAuthorityPins,
  type ConfigurationLiveRegistry,
} from './configuration-authority-contract.ts'
import {
  MAX_CONFIGURATION_INBOX_MS,
  encodeConfigurationSignallingServerFrame,
} from './configuration-signalling-wire.ts'

export interface ConfigurationSignallingEndpoint {
  readonly purpose: 'configuration'
  armDeadline(remainingMs: number, expired: () => void): () => void
  send(wire: string): void
  close(): void
}
export interface ConfigurationSignallingTimers {
  after(ms: number, callback: () => void): () => void
}
/** Current owner/admin authority without any printer assignment requirement. */
export interface ConfigurationAuthorityReader {
  read(scope: ConfigurationScope): Promise<{
    authority: ConfigurationAuthority
    observedAt: number
  } | null>
}
class Handle {
  #owner: object
  constructor(owner: object) {
    this.#owner = owner
  }
  belongsTo(owner: object) {
    return this.#owner === owner
  }
}
export type ConfigurationSignallingHandle = Handle

const ConnectorBegin = z.strictObject({
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  jti: BrowserDeviceUuid,
  token: z.string().min(1).max(8192),
})
const Advertisement = z.strictObject({
  revision: z.number().int().nonnegative().max(2_147_483_646),
})
const Read = z.strictObject({
  authority: ConfigurationAuthority,
  observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const ADMISSION_MS = 8000
const MIN_CONTEXT_MS = 5000
const nonce = () => randomBytes(32).toString('base64url')

type Inbox = {
  id: string
  farmId: string
  agentId: string
  jti: string
  endpoint: ConfigurationSignallingEndpoint
  handle: Handle
  token: string | null
  challenge: CredentialProofChallenge | null
  proved: boolean
  busy: boolean
  revision: number | null
  expiresAt: number
  deadlineMono: number
  context: Context | null
  closed: boolean
  cancel: () => void
  abort: AbortController
}
type Item = {
  from: 'browser' | 'connector'
  wire: string
  bytes: number
  resolve: (ok: boolean) => void
}
type Context = {
  id: string
  scope: ConfigurationScope
  authority: ConfigurationAuthority
  pins: string
  inbox: Inbox
  endpoint: ConfigurationSignallingEndpoint
  handle: Handle
  seq: { browser: number; connector: number }
  ice: { browser: number; connector: number }
  browserNonce: string
  connectorNonce: string
  issuedAt: number
  deadline: number
  deadlineMono: number
  offer: string | null
  answer: string | null
  bindingSha256: string | null
  closed: boolean
  queue: Item[]
  active: boolean
  bytes: number
  cancels: (() => void)[]
}
type Found =
  { kind: 'inbox'; inbox: Inbox } | { kind: 'browser'; context: Context }

/**
 * In-memory config-v1 negotiation, separate from the pause/read-only
 * coordinators. It relays session descriptions between an owner/admin browser
 * and an authenticated, locally enabled Connector, then issues the server view
 * of the RTC binding. A relay or binding is never a write grant: capabilities
 * are issued elsewhere after both peers prove this exact binding.
 */
export class ConfigurationSignallingCoordinator implements ConfigurationLiveRegistry {
  private readonly authority: ConfigurationAuthorityReader
  private readonly credentials: Pick<
    PostgresConnectorCredentialAcceptance,
    'issue' | 'accept'
  >
  private readonly credentialAudience: string
  private readonly clock: SignallingClock
  private readonly timers: ConfigurationSignallingTimers
  private readonly inboxes = new Set<Inbox>()
  private readonly contexts = new Set<Context>()
  private readonly handles = new WeakMap<Handle, Found>()
  private authorityTasks = 0
  private cryptoTasks = 0
  private opening = 0
  private disposed = false
  constructor(input: {
    authority: ConfigurationAuthorityReader
    credentials: Pick<PostgresConnectorCredentialAcceptance, 'issue' | 'accept'>
    credentialAudience: string
    clock: SignallingClock
    timers: ConfigurationSignallingTimers
  }) {
    this.authority = input.authority
    this.credentials = input.credentials
    this.credentialAudience = z
      .string()
      .min(1)
      .max(256)
      .parse(input.credentialAudience)
    this.clock = input.clock
    this.timers = input.timers
  }
  snapshot() {
    return Object.freeze({
      inboxes: this.inboxes.size,
      contexts: this.contexts.size,
      authorityTasks: this.authorityTasks,
      cryptoTasks: this.cryptoTasks,
      disposed: this.disposed,
    })
  }

  /** Step 1 for a Connector: bind its current credential to a server-owned inbox ID. */
  async connectorBegin(
    input: unknown,
    endpoint: ConfigurationSignallingEndpoint,
  ): Promise<
    | {
        kind: 'challenge'
        handle: ConfigurationSignallingHandle
        challenge: CredentialProofChallenge
      }
    | { kind: 'busy'; retryAfterMs: number }
    | null
  > {
    const parsed = ConnectorBegin.safeParse(input)
    if (
      !parsed.success ||
      this.disposed ||
      endpoint.purpose !== 'configuration' ||
      this.inboxes.size >= 64 ||
      [...this.inboxes].filter((i) => i.agentId === parsed.data.agentId)
        .length >= 2 ||
      !this.takeCrypto()
    )
      return null
    const { farmId, agentId, jti, token } = parsed.data
    let inbox: Inbox | null = null
    try {
      const start = signallingClockSample(this.clock)
      const handle = new Handle(this)
      Object.freeze(handle)
      inbox = {
        id: randomUUID(),
        farmId,
        agentId,
        jti,
        endpoint,
        handle,
        token,
        challenge: null,
        proved: false,
        busy: true,
        revision: null,
        expiresAt: start.wall + ADMISSION_MS,
        deadlineMono: start.monotonic + ADMISSION_MS,
        context: null,
        closed: false,
        cancel: () => {},
        abort: new AbortController(),
      }
      this.inboxes.add(inbox)
      this.handles.set(handle, { kind: 'inbox', inbox })
      this.armInbox(inbox)
      const result = await this.credentials.issue({
        token,
        agentId,
        farmId,
        connectionId: inbox.id,
      })
      if (!this.inboxLive(inbox)) return null
      if (!result.ok && result.reason === 'busy') {
        const retryAfterMs = result.retryAfterMs
        this.closeInbox(inbox, false)
        return Number.isSafeInteger(retryAfterMs) &&
          retryAfterMs >= 1 &&
          retryAfterMs <= 60000
          ? { kind: 'busy', retryAfterMs }
          : null
      }
      if (!result.ok || result.kind !== 'challenge') {
        this.closeInbox(inbox)
        return null
      }
      const ch = CredentialProofChallenge.parse(result.challenge)
      const now = this.clock.wall()
      if (
        ch.purpose !== 'signalling' ||
        ch.connection_id !== inbox.id ||
        ch.agent_id !== agentId ||
        ch.farm_id !== farmId ||
        ch.jti !== jti ||
        ch.audience !== this.credentialAudience ||
        ch.token_hash !==
          createHash('sha256').update(token).digest('base64url') ||
        ch.issued_at > now + 250 ||
        ch.expires_at <= now
      ) {
        this.closeInbox(inbox)
        return null
      }
      inbox.challenge = structuredClone(ch)
      return { kind: 'challenge', handle, challenge: structuredClone(ch) }
    } catch {
      if (inbox) this.closeInbox(inbox)
      return null
    } finally {
      if (inbox) inbox.busy = false
      this.cryptoTasks--
    }
  }

  /** Step 2: exactly-once credential proof. Success replaces an older inbox of the agent. */
  async connectorProve(
    handle: ConfigurationSignallingHandle,
    signature: unknown,
  ): Promise<Readonly<{
    inboxId: string
    issuedAt: number
    expiresAt: number
  }> | null> {
    const found = this.find(handle)
    if (!found || found.kind !== 'inbox') return null
    const inbox = found.inbox
    if (
      !this.inboxLive(inbox) ||
      inbox.proved ||
      inbox.busy ||
      !inbox.challenge ||
      !inbox.token ||
      !this.takeCrypto()
    )
      return null
    inbox.busy = true
    try {
      const token = inbox.token
      inbox.token = null
      const accepted = await acceptSignallingProof({
        credentials: this.credentials,
        clock: this.clock,
        timers: this.timers,
        deadline: inbox.deadlineMono,
        signal: inbox.abort.signal,
        request: {
          token,
          agentId: inbox.agentId,
          farmId: inbox.farmId,
          connectionId: inbox.id,
          challenge: inbox.challenge,
          signature,
        },
      })
      const now = signallingClockSample(this.clock)
      if (
        !this.inboxLive(inbox) ||
        !accepted.ok ||
        accepted.kind !== 'accepted' ||
        accepted.purpose !== 'signalling' ||
        accepted.agentId !== inbox.agentId ||
        accepted.farmId !== inbox.farmId ||
        accepted.jti !== inbox.jti ||
        accepted.connectionId !== inbox.id ||
        !Number.isSafeInteger(accepted.expiresAt) ||
        accepted.expiresAt <= now.wall
      ) {
        this.closeInbox(inbox)
        return null
      }
      const lifetime = Math.min(
        accepted.expiresAt - now.wall,
        MAX_CONFIGURATION_INBOX_MS,
      )
      inbox.expiresAt = now.wall + lifetime
      inbox.deadlineMono = now.monotonic + lifetime
      inbox.proved = true
      this.armInbox(inbox)
      if (!this.inboxLive(inbox)) return null
      for (const other of [...this.inboxes])
        if (other !== inbox && other.agentId === inbox.agentId && other.proved)
          this.closeInbox(other)
      return Object.freeze({
        inboxId: inbox.id,
        issuedAt: now.wall,
        expiresAt: inbox.expiresAt,
      })
    } catch {
      this.closeInbox(inbox)
      return null
    } finally {
      inbox.busy = false
      this.cryptoTasks--
    }
  }

  /** Only an authenticated Connector whose operator enabled configuration advertises. */
  advertise(handle: ConfigurationSignallingHandle, input: unknown): boolean {
    const found = this.find(handle)
    const parsed = Advertisement.safeParse(input)
    if (
      !found ||
      found.kind !== 'inbox' ||
      !parsed.success ||
      !this.inboxLive(found.inbox) ||
      !found.inbox.proved
    )
      return false
    found.inbox.revision = parsed.data.revision
    return true
  }

  /** Browser entry. Scope's session ID must come from the sealed own-login cookie. */
  async open(
    input: unknown,
    endpoint: ConfigurationSignallingEndpoint,
  ): Promise<Readonly<{
    handle: ConfigurationSignallingHandle
    readyWire: string
  }> | null> {
    const scope = ConfigurationScope.safeParse(input)
    if (
      !scope.success ||
      this.disposed ||
      endpoint.purpose !== 'configuration' ||
      this.contexts.size + this.opening >= 32
    )
      return null
    this.opening++
    try {
      const start = signallingClockSample(this.clock)
      const read = await this.read(scope.data)
      const now = signallingClockSample(this.clock)
      if (
        !read ||
        this.disposed ||
        now.monotonic - start.monotonic >= ADMISSION_MS ||
        now.monotonic < start.monotonic
      )
        return null
      const a = read.authority
      const inbox = this.currentInbox(a.farm_id, a.agent_id)
      // Stale or foreign Connector: the live socket must hold the current credential.
      if (
        !inbox ||
        inbox.revision === null ||
        inbox.jti !== a.credential_jti ||
        inbox.context ||
        [...this.contexts].some((c) => c.authority.key_id === a.key_id)
      )
        return null
      const deadline = Math.min(
        a.validUntil,
        read.observedAt + CONFIGURATION_HARD_MAXIMUMS.bindingMs,
        inbox.expiresAt,
      )
      const remaining = deadline - Math.max(read.observedAt, now.wall)
      if (remaining < MIN_CONTEXT_MS) return null
      const handle = new Handle(this)
      Object.freeze(handle)
      const c: Context = {
        id: randomUUID(),
        scope: Object.freeze(scope.data),
        authority: a,
        pins: configurationAuthorityPins(a),
        inbox,
        endpoint,
        handle,
        seq: { browser: 0, connector: 0 },
        ice: { browser: 0, connector: 0 },
        browserNonce: nonce(),
        connectorNonce: nonce(),
        issuedAt: read.observedAt,
        deadline,
        deadlineMono: Math.min(now.monotonic + remaining, inbox.deadlineMono),
        offer: null,
        answer: null,
        bindingSha256: null,
        closed: false,
        queue: [],
        active: false,
        bytes: 0,
        cancels: [],
      }
      this.contexts.add(c)
      inbox.context = c
      this.handles.set(handle, { kind: 'browser', context: c })
      try {
        c.cancels.push(
          endpoint.armDeadline(
            Math.max(0, c.deadlineMono - this.clock.monotonic()),
            () => this.close(c),
          ),
        )
        this.schedule(c)
        const lease = { issued_at: c.issuedAt, expires_at: c.deadline }
        const ids = {
          transport_id: c.id,
          farm_id: a.farm_id,
          agent_id: a.agent_id,
          key_id: a.key_id,
        }
        inbox.endpoint.send(
          encodeConfigurationSignallingServerFrame({
            v: 1,
            t: 'config.context-request',
            ...ids,
            account_id: a.account_id,
            browser_public_key: a.browser_public_key,
            browser_thumbprint: a.browser_thumbprint,
            connector_nonce: c.connectorNonce,
            ...lease,
          }),
        )
        const readyWire = encodeConfigurationSignallingServerFrame({
          v: 1,
          t: 'config.ready',
          ...ids,
          revision: inbox.revision,
          browser_nonce: c.browserNonce,
          ...lease,
        })
        return this.live(c) ? Object.freeze({ handle, readyWire }) : null
      } catch {
        this.close(c)
        return null
      }
    } catch {
      return null
    } finally {
      this.opening--
    }
  }

  /** Accepts only bounded rtc.* frames for the caller's own transport. */
  relay(
    handle: ConfigurationSignallingHandle,
    wire: unknown,
  ): Promise<boolean> {
    const found = this.find(handle)
    if (!found) return Promise.resolve(false)
    const c = found.kind === 'browser' ? found.context : found.inbox.context
    if (!c || !this.live(c)) return Promise.resolve(false)
    const bytes = typeof wire === 'string' ? Buffer.byteLength(wire) : 0
    if (
      typeof wire !== 'string' ||
      bytes > 8192 ||
      c.queue.length >= 8 ||
      c.bytes + bytes > 32768
    ) {
      this.close(c)
      return Promise.resolve(false)
    }
    c.bytes += bytes
    return new Promise((resolve) => {
      c.queue.push({
        from: found.kind === 'browser' ? 'browser' : 'connector',
        wire,
        bytes,
        resolve,
      })
      void this.pump(c)
    })
  }

  closeHandle(handle: ConfigurationSignallingHandle): void {
    const found = this.find(handle)
    if (found?.kind === 'browser') this.close(found.context)
    else if (found) this.closeInbox(found.inbox)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const c of [...this.contexts]) this.close(c)
    for (const inbox of [...this.inboxes]) this.closeInbox(inbox)
  }

  bound(bindingSha256: string) {
    for (const c of this.contexts)
      if (c.bindingSha256 === bindingSha256 && this.live(c))
        return Object.freeze({ transportId: c.id, expiresAt: c.deadline })
    return null
  }
  advertised(farmId: string, agentId: string) {
    const inbox = this.currentInbox(farmId, agentId)
    return inbox && inbox.revision !== null
      ? Object.freeze({ jti: inbox.jti, revision: inbox.revision })
      : null
  }

  private currentInbox(farmId: string, agentId: string): Inbox | null {
    for (const inbox of this.inboxes)
      if (
        inbox.proved &&
        inbox.farmId === farmId &&
        inbox.agentId === agentId &&
        this.inboxLive(inbox)
      )
        return inbox
    return null
  }
  private find(handle: unknown): Found | undefined {
    return handle instanceof Handle && handle.belongsTo(this)
      ? this.handles.get(handle)
      : undefined
  }
  private async pump(c: Context): Promise<void> {
    if (c.active) return
    c.active = true
    try {
      while (this.live(c) && c.queue.length) {
        const item = c.queue.shift()!
        let success = false
        try {
          const frame = decodeAuthenticatedSignallingFrame(item.wire)
          if (frame.transport_id !== c.id || frame.seq !== c.seq[item.from])
            throw new Error('Foreign or reordered frame')
          c.seq[item.from]++
          switch (frame.t) {
            case 'rtc.close':
              this.close(c)
              break
            case 'rtc.offer':
              if (item.from !== 'connector' || c.offer)
                throw new Error('Offer order')
              c.offer = frame.p.sdp
              break
            case 'rtc.answer':
              if (item.from !== 'browser' || !c.offer || c.answer)
                throw new Error('Answer order')
              c.answer = frame.p.sdp
              break
            case 'rtc.ice':
              if (!c.offer || ++c.ice[item.from] > 64)
                throw new Error('ICE order')
              break
          }
          if (frame.t !== 'rtc.ice' && frame.t !== 'rtc.close')
            if (!(await this.revalidate(c)))
              throw new Error('Authority changed')
          if (!this.live(c)) break
          const target = item.from === 'browser' ? c.inbox.endpoint : c.endpoint
          target.send(item.wire)
          if (frame.t === 'rtc.answer') await this.bind(c)
          success = this.live(c)
        } catch {
          this.close(c)
        } finally {
          c.bytes -= item.bytes
          item.resolve(success && !c.closed)
        }
      }
    } finally {
      c.active = false
    }
  }
  private async bind(c: Context): Promise<void> {
    if (!c.offer || !c.answer || !this.takeCrypto())
      throw new Error('Binding unavailable')
    try {
      const { role: _role, validUntil: _validUntil, ...pins } = c.authority
      const binding = await validateConfigurationSessionBinding(
        ConfigurationSessionBinding.parse({
          ...pins,
          v: 1,
          purpose: 'configuration-rtc',
          protocol: CONFIGURATION_PROTOCOL,
          transport_id: c.id,
          browser_nonce: c.browserNonce,
          connector_nonce: c.connectorNonce,
          issued_at: c.issuedAt,
          expires_at: c.deadline,
          offer_sha256: await controlSdpHash(c.offer),
          answer_sha256: await controlSdpHash(c.answer),
          browser_dtls: controlDtlsFingerprint(c.answer),
          connector_dtls: controlDtlsFingerprint(c.offer),
        }),
      )
      const hash = await configurationBindingHash(binding)
      if (!this.live(c)) throw new Error('Closed while binding')
      const wire = encodeConfigurationSignallingServerFrame({
        v: 1,
        t: 'config.binding',
        binding,
      })
      c.bindingSha256 = hash
      c.endpoint.send(wire)
      c.inbox.endpoint.send(wire)
    } finally {
      this.cryptoTasks--
    }
  }
  private async read(scope: ConfigurationScope) {
    if (this.disposed || this.authorityTasks >= 8) return null
    this.authorityTasks++
    try {
      const parsed = Read.safeParse(await this.authority.read(scope))
      if (
        !parsed.success ||
        parsed.data.authority.farm_id !== scope.farmId ||
        parsed.data.authority.agent_id !== scope.agentId ||
        parsed.data.authority.key_id !== scope.keyId ||
        parsed.data.observedAt >= parsed.data.authority.validUntil
      )
        return null
      return parsed.data
    } catch {
      return null
    } finally {
      this.authorityTasks--
    }
  }
  /** Can only shorten the context; a changed pin closes it. */
  private async revalidate(c: Context): Promise<boolean> {
    if (!this.live(c)) return false
    const read = await this.read(c.scope)
    if (
      !this.live(c) ||
      !read ||
      configurationAuthorityPins(read.authority) !== c.pins ||
      read.observedAt >= c.deadline ||
      c.inbox.jti !== read.authority.credential_jti
    )
      return false
    c.deadline = Math.min(c.deadline, read.authority.validUntil)
    return this.live(c)
  }
  private schedule(c: Context): void {
    if (c.closed) return
    const cancel = this.timers.after(5000, () => {
      void this.revalidate(c)
        .then((ok) => (ok ? this.schedule(c) : this.close(c)))
        .catch(() => this.close(c))
    })
    if (c.closed) cancel()
    else c.cancels.push(cancel)
  }
  private armInbox(inbox: Inbox): void {
    const previous = inbox.cancel
    inbox.cancel = () => {}
    previous()
    if (inbox.closed) return
    const next = inbox.endpoint.armDeadline(
      Math.max(0, inbox.deadlineMono - this.clock.monotonic()),
      () => this.closeInbox(inbox),
    )
    if (inbox.closed) next()
    else inbox.cancel = next
  }
  private inboxLive(inbox: Inbox): boolean {
    if (inbox.closed || this.disposed) return false
    try {
      const now = signallingClockSample(this.clock)
      if (now.monotonic < inbox.deadlineMono && now.wall < inbox.expiresAt)
        return true
    } catch {}
    this.closeInbox(inbox)
    return false
  }
  private live(c: Context): boolean {
    if (c.closed || this.disposed || !this.inboxLive(c.inbox)) {
      this.close(c)
      return false
    }
    try {
      const now = signallingClockSample(this.clock)
      if (now.monotonic < c.deadlineMono && now.wall < c.deadline) return true
    } catch {}
    this.close(c)
    return false
  }
  private takeCrypto(): boolean {
    if (this.disposed || this.cryptoTasks >= 8) return false
    this.cryptoTasks++
    return true
  }
  private close(c: Context): void {
    if (c.closed) return
    c.closed = true
    this.contexts.delete(c)
    this.handles.delete(c.handle)
    c.bindingSha256 = null
    if (c.inbox.context === c) c.inbox.context = null
    for (const item of c.queue.splice(0)) {
      c.bytes -= item.bytes
      item.resolve(false)
    }
    for (const cancel of c.cancels.splice(0))
      try {
        cancel()
      } catch {}
    try {
      c.endpoint.close()
    } catch {}
    if (!c.inbox.closed)
      try {
        c.inbox.endpoint.send(
          encodeConfigurationSignallingServerFrame({
            v: 1,
            t: 'config.context-closed',
            transport_id: c.id,
          }),
        )
      } catch {
        this.closeInbox(c.inbox)
      }
  }
  private closeInbox(inbox: Inbox, closeEndpoint = true): void {
    if (inbox.closed) return
    inbox.closed = true
    this.inboxes.delete(inbox)
    this.handles.delete(inbox.handle)
    inbox.token = null
    inbox.revision = null
    try {
      inbox.abort.abort()
    } catch {}
    const cancel = inbox.cancel
    inbox.cancel = () => {}
    try {
      cancel()
    } catch {}
    if (inbox.context) this.close(inbox.context)
    if (closeEndpoint)
      try {
        inbox.endpoint.close()
      } catch {}
  }
}
