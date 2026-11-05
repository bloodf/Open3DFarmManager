import { z } from 'zod'
import { randomBytes, randomUUID } from 'node:crypto'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import { base64url } from '../../../../packages/farm-protocol/src/encoding.ts'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  BrowserTransportProofChallenge,
  verifyBrowserTransportProof,
} from '../../../../packages/farm-protocol/src/browser-transport-proof.ts'
import { CredentialProofChallenge } from '../../../../packages/farm-protocol/src/credential-proof.ts'
import {
  RtcSessionBindingV2,
  type RtcSessionBinding,
  rtcSdpHash,
  rtcDtlsFingerprint,
  type RtcPeerRole,
} from '../../../../packages/farm-protocol/src/rtc-session-binding.ts'
import { acceptSignallingProof } from './signalling-proof-acceptance.ts'
import { decodeAuthenticatedSignallingFrame } from '../../../../packages/farm-protocol/src/authenticated-signalling.ts'
import {
  signallingClockSample,
  signallingRemaining,
  type SignallingReadBudget,
} from './signalling-clock.ts'
import type { PostgresConnectorCredentialAcceptance } from '../storage/postgres-connector-credential-acceptance.ts'
const Scope = z.strictObject({
  sessionRecordId: BrowserDeviceTextId,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  keyId: BrowserDeviceUuid,
})
export type SignallingScope = z.infer<typeof Scope>
const shape = RtcSessionBindingV2.shape
const Authority = z.strictObject({
  assignment_count: shape.assignment_count,
  assignment_digest: shape.assignment_digest,
  farm_id: shape.farm_id,
  agent_id: shape.agent_id,
  account_id: shape.account_id,
  key_id: shape.key_id,
  browser_public_key: shape.browser_public_key,
  browser_thumbprint: shape.browser_thumbprint,
  connector_public_key_spki: shape.connector_public_key_spki,
  connector_fingerprint: shape.connector_fingerprint,
  credential_jti: shape.credential_jti,
  origin: shape.origin,
  audience: shape.audience,
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export type SignallingAuthority = z.infer<typeof Authority>
const Snapshot = z.strictObject({
  authority: Authority,
  budget: z.strictObject({
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    monotonicDeadline: z.number().finite().nonnegative(),
  }),
})
export type SignallingAuthoritySnapshot = z.infer<typeof Snapshot>
/** Trusted reader must independently validate the current login/session, membership,
 * approved browser key, enrollment and issued credential. It must never touch the session. */
export interface SignallingAuthoritySource {
  read(scope: SignallingScope): Promise<SignallingAuthoritySnapshot | null>
}
/** Implemented by each trusted endpoint adapter, not by a received network frame.
 * armDeadline must own a monotonic timer and irrevocably close its peer on expiry.
 * bindReadOnly must reject closed contexts and cannot enable commands. */
export interface SignallingEndpoint {
  armDeadline(remainingMs: number, expired: () => void): () => void
  send(wire: string): void
  bindReadOnly(binding: RtcSessionBinding): void
  close(): void
}
export interface SignallingClock {
  wall(): number
  monotonic(): number
}
export interface SignallingTimers {
  after(ms: number, callback: () => void): () => void
}
export type SignallingHandle = Readonly<object>
interface Peer {
  role: RtcPeerRole
  endpoint: SignallingEndpoint
  handle: SignallingHandle
  cancel: () => void
  busy: boolean
  proved: boolean
  seq: number
  ice: number
}
interface Context {
  scope: SignallingScope
  authority: SignallingAuthority
  budget: SignallingReadBudget
  deadlineMono: number
  admissionMono: number
  pins: string
  id: string
  createdWall: number
  createdMono: number
  observedWall: number
  observedMono: number
  deadline: number
  closed: boolean
  abort: AbortController
  admitted: boolean
  browser: Peer
  connector: Peer | null
  browserChallenge: BrowserTransportProofChallenge
  connectorChallenge: CredentialProofChallenge | null
  token: string | null
  offer: string | null
  answer: string | null
  queue: {
    peer: Peer
    wire: string
    bytes: number
    settled: ((ok: boolean) => void) | null
  }[]
  queuedBytes: number
  pumping: boolean
  revalidationCancel: (() => void) | null
  cancels: (() => void)[]
}
/** In-memory rendezvous only. Restart discards all authority and requires new proofs.
 * No database reader or network/RTC adapter is wired by this module. */
export class SignallingCoordinator {
  private contexts = new Set<Context>()
  private handles = new WeakMap<
    SignallingHandle,
    { context: Context; peer: Peer }
  >()
  private pendingReads = new Set<() => void>()
  private allocating = 0
  private cryptoTasks = 0
  private authorityTasks = 0
  private disposed = false
  private authority: SignallingAuthoritySource
  private credentials: Pick<
    PostgresConnectorCredentialAcceptance,
    'issue' | 'accept'
  >
  private clock: SignallingClock
  private timers: SignallingTimers
  constructor(
    authority: SignallingAuthoritySource,
    credentials: Pick<
      PostgresConnectorCredentialAcceptance,
      'issue' | 'accept'
    >,
    clock: SignallingClock,
    timers: SignallingTimers,
  ) {
    this.authority = authority
    this.credentials = credentials
    this.clock = clock
    this.timers = timers
  }
  async open(
    scopeInput: unknown,
    endpoint: SignallingEndpoint,
  ): Promise<{
    handle: SignallingHandle
    challenge: BrowserTransportProofChallenge
  } | null> {
    if (this.disposed || this.contexts.size + this.allocating >= 64) return null
    const parsed = Scope.safeParse(scopeInput)
    if (!parsed.success) return null
    const startedWall = this.clock.wall(),
      startedMono = this.clock.monotonic()
    if (!this.validTime(startedWall, startedMono)) return null
    this.allocating++
    try {
      let expired = false
      let cancelReadDeadline = () => {}
      const abandon = () => {
        expired = true
        cancelReadDeadline()
        this.pendingReads.delete(abandon)
        try {
          endpoint.close()
        } catch {}
      }
      this.pendingReads.add(abandon)
      cancelReadDeadline = this.timers.after(8000, abandon)
      let value: SignallingAuthoritySnapshot | null
      try {
        value = await this.readAuthority(parsed.data)
      } finally {
        cancelReadDeadline()
        this.pendingReads.delete(abandon)
      }
      if (expired) return null
      const snapshot = Snapshot.safeParse(value)
      const auth = snapshot.success
        ? Authority.safeParse(snapshot.data.authority)
        : Authority.safeParse(null)
      const wall = this.clock.wall(),
        mono = this.clock.monotonic()
      if (
        this.disposed ||
        !auth.success ||
        !this.validTime(wall, mono) ||
        wall < startedWall ||
        mono < startedMono ||
        wall - startedWall >= 8000 ||
        mono - startedMono >= 8000 ||
        !snapshot.success ||
        snapshot.data.budget.validUntil !== auth.data.validUntil ||
        snapshot.data.budget.monotonicDeadline <= mono ||
        !this.matches(parsed.data, auth.data)
      )
        return null
      if (
        [...this.contexts].filter(
          (c) => c.authority.key_id === auth.data.key_id,
        ).length >= 2 ||
        [...this.contexts].filter(
          (c) => c.authority.agent_id === auth.data.agent_id,
        ).length >= 4
      )
        return null
      if (!snapshot.success) return null
      const timing = signallingRemaining({
        anchor: { wall: startedWall, monotonic: startedMono },
        now: { wall, monotonic: mono },
        authorization: snapshot.data.budget,
      })
      const admissionMono = Math.min(
        startedMono + 8000,
        timing.monotonicDeadline,
      )
      const id = randomUUID(),
        deadline = Math.min(
          auth.data.validUntil,
          snapshot.data.budget.observedAt + timing.remaining,
        )
      const challenge = BrowserTransportProofChallenge.parse({
        v: 1,
        purpose: 'signalling-admission',
        transport_id: id,
        farm_id: auth.data.farm_id,
        agent_id: auth.data.agent_id,
        key_id: auth.data.key_id,
        account_id: auth.data.account_id,
        thumbprint: auth.data.browser_thumbprint,
        origin: auth.data.origin,
        audience: auth.data.audience,
        nonce: base64url(randomBytes(32)),
        issued_at: snapshot.data.budget.observedAt,
        expires_at: Math.min(
          snapshot.data.budget.observedAt + Math.floor(admissionMono - mono),
          deadline,
        ),
      })
      const peer: Peer = {
        role: 'browser',
        endpoint,
        handle: Object.freeze({}),
        cancel: () => {},
        busy: false,
        proved: false,
        seq: 0,
        ice: 0,
      }
      const context: Context = {
        scope: parsed.data,
        authority: auth.data,
        budget: snapshot.data.budget,
        deadlineMono: timing.monotonicDeadline,
        admissionMono,
        pins: this.pins(auth.data),
        id,
        createdWall: startedWall,
        createdMono: startedMono,
        observedWall: wall,
        observedMono: mono,
        deadline,
        closed: false,
        abort: new AbortController(),
        admitted: false,
        browser: peer,
        connector: null,
        browserChallenge: challenge,
        connectorChallenge: null,
        token: null,
        offer: null,
        answer: null,
        queue: [],
        queuedBytes: 0,
        pumping: false,
        revalidationCancel: null,
        cancels: [],
      }
      this.contexts.add(context)
      this.handles.set(peer.handle, { context, peer })
      try {
        peer.cancel = endpoint.armDeadline(timing.remaining, () =>
          this.close(context),
        )
        if (context.closed) {
          peer.cancel()
          return null
        }
        context.cancels.push(
          this.timers.after(admissionMono - mono, () => {
            if (!context.admitted) this.close(context)
          }),
        )
        context.cancels.push(
          this.timers.after(timing.remaining, () => this.close(context)),
        )
        this.revalidationTimer(context)
      } catch {
        this.close(context)
        return null
      }
      return context.closed
        ? null
        : { handle: peer.handle, challenge: structuredClone(challenge) }
    } catch {
      return null
    } finally {
      this.allocating--
    }
  }
  /** Only the trusted rendezvous caller can associate this handle with its Connector socket. */
  async attachConnector(
    browserHandle: SignallingHandle,
    endpoint: SignallingEndpoint,
    token: string,
    lifetime: { expiresAt: number; monotonicDeadline: number },
  ): Promise<
    | {
        kind: 'challenge'
        handle: SignallingHandle
        challenge: CredentialProofChallenge
      }
    | { kind: 'busy'; retryAfterMs: number }
    | null
  > {
    const found = this.handles.get(browserHandle)
    if (!found || found.peer.role !== 'browser') return null
    const c = found.context
    if (
      !this.live(c) ||
      c.connector ||
      typeof token !== 'string' ||
      token.length > 8192 ||
      !token.length
    )
      return null
    if (
      !Number.isSafeInteger(lifetime.expiresAt) ||
      !Number.isFinite(lifetime.monotonicDeadline) ||
      lifetime.expiresAt <= c.budget.observedAt ||
      lifetime.monotonicDeadline <= this.clock.monotonic()
    ) {
      this.close(c)
      return null
    }
    c.deadline = Math.min(c.deadline, lifetime.expiresAt)
    c.deadlineMono = Math.min(c.deadlineMono, lifetime.monotonicDeadline)
    c.admissionMono = Math.min(c.admissionMono, c.deadlineMono)
    c.browser.cancel()
    c.browser.cancel = c.browser.endpoint.armDeadline(
      c.deadlineMono - this.clock.monotonic(),
      () => this.close(c),
    )
    const peer: Peer = {
      role: 'connector',
      endpoint,
      handle: Object.freeze({}),
      cancel: () => {},
      busy: true,
      proved: false,
      seq: 0,
      ice: 0,
    }
    c.connector = peer
    this.handles.set(peer.handle, { context: c, peer })
    try {
      peer.cancel = endpoint.armDeadline(
        c.deadlineMono - this.clock.monotonic(),
        () => this.close(c),
      )
      if (c.closed) {
        peer.cancel()
        return null
      }
      if (!this.live(c) || !this.takeCrypto()) {
        this.close(c)
        return null
      }
      let result
      try {
        result = await this.credentials.issue({
          token,
          agentId: c.authority.agent_id,
          farmId: c.authority.farm_id,
          connectionId: c.id,
        })
      } finally {
        this.cryptoTasks--
      }
      if (this.live(c) && !result.ok && result.reason === 'busy') {
        this.handles.delete(peer.handle)
        peer.cancel()
        c.connector = null
        return { kind: 'busy', retryAfterMs: result.retryAfterMs }
      }
      if (!this.live(c) || !result.ok || result.kind !== 'challenge') {
        this.close(c)
        return null
      }
      const ch = result.challenge
      if (
        ch.issued_at > this.clock.wall() + 250 ||
        ch.expires_at <= this.clock.wall() ||
        ch.purpose !== 'signalling' ||
        ch.connection_id !== c.id ||
        ch.agent_id !== c.authority.agent_id ||
        ch.farm_id !== c.authority.farm_id ||
        ch.jti !== c.authority.credential_jti ||
        ch.origin !== c.authority.origin ||
        ch.audience !== c.authority.audience ||
        ch.public_key_spki !== c.authority.connector_public_key_spki ||
        ch.fingerprint !== c.authority.connector_fingerprint
      ) {
        this.close(c)
        return null
      }
      c.connectorChallenge = structuredClone(ch)
      c.token = token
      return {
        kind: 'challenge',
        handle: peer.handle,
        challenge: structuredClone(ch),
      }
    } catch {
      this.close(c)
      return null
    } finally {
      peer.busy = false
    }
  }
  async prove(handle: SignallingHandle, signature: unknown): Promise<boolean> {
    const found = this.handles.get(handle)
    if (!found) return false
    const { context: c, peer } = found
    if (!this.live(c) || peer.proved || peer.busy || !this.takeCrypto())
      return false
    peer.busy = true
    try {
      let valid = false
      let proofExpiresAt = c.browserChallenge.expires_at
      if (peer.role === 'browser')
        valid = await verifyBrowserTransportProof(
          c.browserChallenge,
          c.authority.browser_public_key,
          signature,
        )
      else if (c.connectorChallenge && c.token) {
        proofExpiresAt = c.connectorChallenge.expires_at
        const result = await acceptSignallingProof({
          credentials: this.credentials,
          clock: this.clock,
          timers: this.timers,
          deadline: Math.min(c.admissionMono, c.deadlineMono),
          signal: c.abort.signal,
          request: {
            token: c.token,
            agentId: c.authority.agent_id,
            farmId: c.authority.farm_id,
            connectionId: c.id,
            challenge: c.connectorChallenge,
            signature,
          },
        })
        valid =
          result.ok &&
          result.kind === 'accepted' &&
          result.acceptedAt <= this.clock.wall() + 250 &&
          result.expiresAt > this.clock.wall() &&
          result.purpose === 'signalling' &&
          result.connectionId === c.id &&
          result.jti === c.authority.credential_jti &&
          result.agentId === c.authority.agent_id &&
          result.farmId === c.authority.farm_id
        c.token = null
      }
      if (
        !this.live(c) ||
        !valid ||
        !(await this.revalidate(c, proofExpiresAt))
      ) {
        this.close(c)
        return false
      }
      peer.proved = true
      if (c.browser.proved && c.connector?.proved) c.admitted = true
      return true
    } catch {
      this.close(c)
      return false
    } finally {
      peer.busy = false
      this.cryptoTasks--
    }
  }
  /** Trusted runtime metadata only; every operation still revalidates current SQL. */
  describe(handle: SignallingHandle): {
    transportId: string
    issuedAt: number
    expiresAt: number
    admissionExpiresAt: number
    agentId: string
    farmId: string
    jti: string
  } | null {
    const found = this.handles.get(handle)
    if (!found || !this.live(found.context)) return null
    const c = found.context
    return {
      transportId: c.id,
      issuedAt: c.budget.observedAt,
      expiresAt: c.deadline,
      admissionExpiresAt: Math.min(c.deadline, c.browserChallenge.expires_at),
      agentId: c.authority.agent_id,
      farmId: c.authority.farm_id,
      jti: c.authority.credential_jti,
    }
  }
  receive(handle: SignallingHandle, wire: unknown): boolean {
    return this.enqueue(handle, wire, null)
  }
  /** Holds the socket's in-flight resource budget through SQL and relay completion. */
  receiveAndWait(handle: SignallingHandle, wire: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.enqueue(handle, wire, resolve)) resolve(false)
    })
  }
  private enqueue(
    handle: SignallingHandle,
    wire: unknown,
    settled: ((ok: boolean) => void) | null,
  ): boolean {
    const found = this.handles.get(handle)
    if (!found) return false
    const { context: c, peer } = found
    if (
      !this.live(c) ||
      !c.admitted ||
      typeof wire !== 'string' ||
      wire.length > 8192
    )
      return false
    const bytes = Buffer.byteLength(wire)
    if (
      bytes > 8192 ||
      c.queue.filter((x) => x.peer === peer).length >= 8 ||
      c.queuedBytes + bytes > 32768
    ) {
      this.close(c)
      return false
    }
    c.queue.push({ peer, wire, bytes, settled })
    c.queuedBytes += bytes
    void this.pump(c)
    return true
  }
  disconnect(handle: SignallingHandle): void {
    const found = this.handles.get(handle)
    if (found) this.close(found.context)
  }
  dispose(): void {
    this.disposed = true
    for (const abandon of this.pendingReads) abandon()
    for (const c of this.contexts) this.close(c)
  }
  private async pump(c: Context): Promise<void> {
    if (c.pumping) return
    c.pumping = true
    try {
      while (this.live(c) && c.queue.length) {
        const item = c.queue.shift()
        if (!item) break
        let delivered = false
        try {
          const frame = decodeAuthenticatedSignallingFrame(item.wire),
            peer = item.peer
          if (
            frame.transport_id !== c.id ||
            frame.seq !== peer.seq ||
            !(await this.revalidate(c))
          )
            throw new Error('Denied')
          peer.seq++
          const other = peer.role === 'browser' ? c.connector : c.browser
          if (!other || !this.live(c)) throw new Error('Closed')
          switch (frame.t) {
            case 'rtc.close':
              this.close(c)
              return
            case 'rtc.offer':
              if (peer.role !== 'connector' || c.offer)
                throw new Error('Offer order')
              c.offer = frame.p.sdp
              break
            case 'rtc.answer':
              if (peer.role !== 'browser' || !c.offer || c.answer)
                throw new Error('Answer order')
              c.answer = frame.p.sdp
              break
            case 'rtc.ice':
              if (!c.offer || ++peer.ice > 64) throw new Error('ICE limit')
              break
          }
          other.endpoint.send(item.wire)
          if (
            frame.t === 'rtc.answer' &&
            c.offer &&
            c.answer &&
            c.connectorChallenge
          ) {
            const offer = c.offer,
              answer = c.answer
            const [offerHash, answerHash] = await Promise.all([
              rtcSdpHash(offer),
              rtcSdpHash(answer),
            ])
            if (!(await this.revalidate(c)))
              throw new Error('Denied after SDP hashing')
            const { validUntil: _, ...pins } = c.authority
            const binding = RtcSessionBindingV2.parse({
              ...pins,
              v: 2,
              purpose: 'read-only-rtc',
              transport_id: c.id,
              browser_nonce: c.browserChallenge.nonce,
              connector_nonce: c.connectorChallenge.nonce,
              issued_at: c.budget.observedAt,
              expires_at: c.deadline,
              commands_enabled: false,
              offer_sha256: offerHash,
              answer_sha256: answerHash,
              browser_dtls: rtcDtlsFingerprint(answer),
              connector_dtls: rtcDtlsFingerprint(offer),
            })
            c.browser.endpoint.bindReadOnly(structuredClone(binding))
            if (!this.live(c)) throw new Error('Closed during binding')
            c.connector?.endpoint.bindReadOnly(structuredClone(binding))
          }
          delivered = true
        } finally {
          item.settled?.(delivered && !c.closed)
          if (!c.closed) c.queuedBytes -= item.bytes
        }
      }
    } catch {
      this.close(c)
    } finally {
      c.pumping = false
    }
  }
  private async revalidate(
    c: Context,
    proofExpiresAt?: number,
  ): Promise<boolean> {
    if (!this.live(c)) return false
    try {
      const value = Snapshot.safeParse(await this.readAuthority(c.scope))
      if (!this.live(c) || !value.success) return false
      const { authority: auth, budget } = value.data
      if (
        !this.matches(c.scope, auth) ||
        this.pins(auth) !== c.pins ||
        budget.validUntil !== auth.validUntil ||
        budget.observedAt < c.budget.observedAt ||
        budget.observedAt >= c.deadline ||
        (proofExpiresAt !== undefined && budget.observedAt >= proofExpiresAt)
      )
        return false
      const remaining = signallingRemaining({
        anchor: { wall: c.createdWall, monotonic: c.createdMono },
        now: signallingClockSample(this.clock),
        authorization: budget,
        previousDeadline: c.deadlineMono,
      })
      c.authority = auth
      c.budget = budget
      c.deadline = Math.min(c.deadline, auth.validUntil)
      if (remaining.monotonicDeadline < c.deadlineMono) {
        c.deadlineMono = remaining.monotonicDeadline
        for (const peer of [c.browser, c.connector])
          if (peer) {
            peer.cancel()
            peer.cancel = peer.endpoint.armDeadline(remaining.remaining, () =>
              this.close(c),
            )
          }
      }
      return this.live(c)
    } catch {
      return false
    }
  }
  private revalidationTimer(c: Context): void {
    c.revalidationCancel = this.timers.after(5000, () => {
      c.revalidationCancel = null
      void this.revalidate(c).then((ok) => {
        if (!ok) this.close(c)
        else if (!c.closed) this.revalidationTimer(c)
      })
    })
  }
  private live(c: Context): boolean {
    const wall = this.clock.wall(),
      mono = this.clock.monotonic()
    if (c.closed) return false
    if (
      !this.validTime(wall, mono) ||
      wall < c.observedWall ||
      mono < c.observedMono ||
      Math.abs(wall - c.observedWall - (mono - c.observedMono)) > 250 ||
      Math.abs(wall - c.createdWall - (mono - c.createdMono)) > 250 ||
      mono >= c.deadlineMono ||
      (!c.admitted && mono >= c.admissionMono)
    ) {
      this.close(c)
      return false
    }
    c.observedWall = wall
    c.observedMono = mono
    return true
  }
  private close(c: Context): void {
    if (c.closed) return
    c.closed = true
    c.abort.abort()
    c.token = null
    for (const item of c.queue) item.settled?.(false)
    c.queue.length = 0
    c.queuedBytes = 0
    this.contexts.delete(c)
    try {
      c.revalidationCancel?.()
    } catch {}
    c.revalidationCancel = null
    for (const cancel of c.cancels) {
      try {
        cancel()
      } catch {}
    }
    c.cancels.length = 0
    for (const peer of [c.browser, c.connector])
      if (peer) {
        this.handles.delete(peer.handle)
        try {
          peer.cancel()
        } catch {}
        try {
          peer.endpoint.close()
        } catch {}
      }
  }
  private async readAuthority(
    scope: SignallingScope,
  ): Promise<SignallingAuthoritySnapshot | null> {
    if (this.disposed || this.authorityTasks >= 32) return null
    this.authorityTasks++
    try {
      return await this.authority.read(scope)
    } finally {
      this.authorityTasks--
    }
  }
  private validTime(wall: number, mono: number): boolean {
    return (
      Number.isSafeInteger(wall) &&
      wall >= 0 &&
      Number.isFinite(mono) &&
      mono >= 0
    )
  }
  private pins(a: SignallingAuthority): string {
    const { validUntil: _, ...pins } = a
    return canonicalize(pins)
  }
  private matches(scope: SignallingScope, a: SignallingAuthority): boolean {
    return (
      scope.farmId === a.farm_id &&
      scope.agentId === a.agent_id &&
      scope.keyId === a.key_id
    )
  }
  private takeCrypto(): boolean {
    if (this.cryptoTasks >= 32) return false
    this.cryptoTasks++
    return true
  }
}
