import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import { CredentialProofChallenge } from '../../../../packages/farm-protocol/src/credential-proof.ts'
import {
  PauseTransportProofChallenge,
  verifyPauseTransportProof,
} from '../../../../packages/farm-protocol/src/pause-signalling.ts'
import { PauseCapabilityV1 } from '../../../../packages/farm-protocol/src/pause-capability.ts'
import {
  ControlSessionBinding,
  controlSdpHash,
  controlDtlsFingerprint,
} from '../../../../packages/farm-protocol/src/control-session-binding.ts'
import { decodeAuthenticatedSignallingFrame } from '../../../../packages/farm-protocol/src/authenticated-signalling.ts'
import {
  PauseNegotiationAuthority,
  PauseNegotiationScope,
  type PostgresPauseNegotiation,
} from '../storage/postgres-pause-negotiation.ts'
import type { PostgresConnectorCredentialAcceptance } from '../storage/postgres-connector-credential-acceptance.ts'
import { connectorKeyBinding } from '../utils/connector-credentials.ts'
import { acceptSignallingProof } from './signalling-proof-acceptance.ts'
import {
  signallingClockSample,
  signallingRemaining,
  type SignallingClock,
} from './signalling-clock.ts'

export interface PauseSignallingEndpoint {
  readonly purpose: 'pause'
  armDeadline(remainingMs: number, expired: () => void): () => void
  send(wire: string): void
  bindControl(binding: ControlSessionBinding): void
  close(): void
}
export interface PauseSignallingTimers {
  after(ms: number, callback: () => void): () => void
}
class ControlHandle {
  #owner: object
  constructor(owner: object) {
    this.#owner = owner
  }
  belongsTo(owner: object) {
    return this.#owner === owner
  }
}
export type PauseSignallingHandle = ControlHandle
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Snapshot = z.strictObject({
  authority: PauseNegotiationAuthority,
  printerKey: PauseCapabilityV1.shape.printer_key,
  budget: z.strictObject({
    observedAt: time,
    validUntil: time,
    monotonicDeadline: z.number().finite().nonnegative(),
  }),
})
type Snapshot = z.infer<typeof Snapshot>
type Peer = {
  role: 'browser' | 'connector'
  endpoint: PauseSignallingEndpoint
  handle: ControlHandle
  proved: boolean
  busy: boolean
  seq: number
  ice: number
  cancel: () => void
}
type Item = {
  peer: Peer
  wire: string
  bytes: number
  resolve: (ok: boolean) => void
}
type Context = {
  scope: PauseNegotiationScope
  snapshot: Snapshot
  pins: string
  id: string
  start: { wall: number; monotonic: number }
  last: { wall: number; monotonic: number }
  deadline: number
  deadlineMono: number
  admissionMono: number
  closed: boolean
  admitted: boolean
  bound: boolean
  abort: AbortController
  browser: Peer
  connector: Peer | null
  challenge: PauseTransportProofChallenge
  credentialChallenge: CredentialProofChallenge | null
  token: string | null
  offer: string | null
  answer: string | null
  queue: Item[]
  active: boolean
  outstanding: number
  bytes: number
  cancels: (() => void)[]
  revalidationCancel: (() => void) | null
}
/** In-memory pause negotiation only. Neither proof acceptance nor bindControl is
 * a capability grant. A future runtime must additionally enforce its global caps. */
export class PauseSignallingCoordinator {
  private readonly authority: Pick<PostgresPauseNegotiation, 'read'>
  private readonly credentials: Pick<
    PostgresConnectorCredentialAcceptance,
    'issue' | 'accept'
  >
  private readonly credentialAudience: string
  private readonly clock: SignallingClock
  private readonly timers: PauseSignallingTimers
  private readonly contexts = new Set<Context>()
  private readonly handles = new WeakMap<
    ControlHandle,
    { context: Context; peer: Peer }
  >()
  private readonly pending = new Set<() => void>()
  private allocating = 0
  private authorityTasks = 0
  private cryptoTasks = 0
  private disposed = false
  constructor(input: {
    authority: Pick<PostgresPauseNegotiation, 'read'>
    credentials: Pick<PostgresConnectorCredentialAcceptance, 'issue' | 'accept'>
    credentialAudience: string
    clock: SignallingClock
    timers: PauseSignallingTimers
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
      contexts: this.contexts.size,
      allocating: this.allocating,
      authorityTasks: this.authorityTasks,
      cryptoTasks: this.cryptoTasks,
      disposed: this.disposed,
    })
  }
  private peer(role: Peer['role'], endpoint: PauseSignallingEndpoint): Peer {
    if (endpoint.purpose !== 'pause')
      throw Error('Separate pause endpoint required')
    const handle = new ControlHandle(this)
    Object.freeze(handle)
    return {
      role,
      endpoint,
      handle,
      proved: false,
      busy: false,
      seq: 0,
      ice: 0,
      cancel: () => {},
    }
  }
  async open(
    input: unknown,
    endpoint: PauseSignallingEndpoint,
  ): Promise<Readonly<{
    handle: PauseSignallingHandle
    challenge: PauseTransportProofChallenge
  }> | null> {
    const scope = PauseNegotiationScope.safeParse(input)
    if (
      !scope.success ||
      this.disposed ||
      this.contexts.size + this.allocating >= 64 ||
      endpoint.purpose !== 'pause'
    )
      return null
    this.allocating++
    let expired = false,
      transferred = false,
      cancel = () => {}
    const abandon = () => {
      if (expired || transferred) return
      expired = true
      try {
        endpoint.close()
      } catch {}
    }
    this.pending.add(abandon)
    try {
      const start = signallingClockSample(this.clock)
      if (this.disposed) return null
      cancel = this.timers.after(8000, abandon)
      if (expired || this.disposed) return null
      const snapshot = await this.read(Object.freeze(scope.data))
      const stopReadTimer = cancel
      cancel = () => {}
      stopReadTimer()
      const now = signallingClockSample(this.clock)
      if (
        !snapshot ||
        expired ||
        this.disposed ||
        now.monotonic - start.monotonic >= 8000 ||
        now.wall - start.wall >= 8000 ||
        !this.matches(scope.data, snapshot)
      )
        return null
      const timing = signallingRemaining({
        anchor: start,
        now,
        authorization: snapshot.budget,
      })
      if (this.disposed || expired) return null
      if (
        [...this.contexts].filter(
          (c) => c.snapshot.authority.key_id === snapshot.authority.key_id,
        ).length >= 2 ||
        [...this.contexts].filter(
          (c) => c.snapshot.authority.agent_id === snapshot.authority.agent_id,
        ).length >= 4
      )
        return null
      const deadline = Math.min(
        snapshot.authority.validUntil,
        snapshot.budget.observedAt + timing.remaining,
      )
      const admissionMono = Math.min(
        start.monotonic + 8000,
        timing.monotonicDeadline,
      )
      const id = randomUUID()
      const challenge = PauseTransportProofChallenge.parse({
        v: 1,
        purpose: 'pause-signalling-admission',
        transport_id: id,
        farm_id: snapshot.authority.farm_id,
        agent_id: snapshot.authority.agent_id,
        key_id: snapshot.authority.key_id,
        assignment_id: snapshot.authority.assignment_id,
        account_id: snapshot.authority.account_id,
        thumbprint: snapshot.authority.browser_thumbprint,
        origin: snapshot.authority.origin,
        audience: snapshot.authority.audience,
        nonce: randomBytes(32).toString('base64url'),
        issued_at: snapshot.budget.observedAt,
        expires_at: Math.min(
          deadline,
          snapshot.budget.observedAt +
            Math.floor(admissionMono - now.monotonic),
        ),
      })
      const browser = this.peer('browser', endpoint)
      const c: Context = {
        scope: Object.freeze(scope.data),
        snapshot,
        pins: this.pins(snapshot),
        id,
        start,
        last: now,
        deadline,
        deadlineMono: timing.monotonicDeadline,
        admissionMono,
        closed: false,
        admitted: false,
        bound: false,
        abort: new AbortController(),
        browser,
        connector: null,
        challenge,
        credentialChallenge: null,
        token: null,
        offer: null,
        answer: null,
        queue: [],
        active: false,
        outstanding: 0,
        bytes: 0,
        cancels: [],
        revalidationCancel: null,
      }
      this.contexts.add(c)
      this.handles.set(browser.handle, { context: c, peer: browser })
      transferred = true
      try {
        this.arm(c, browser)
        const stopAdmission = this.timers.after(
          Math.max(0, admissionMono - this.clock.monotonic()),
          () => {
            if (!c.admitted) this.close(c)
          },
        )
        if (c.closed) {
          stopAdmission()
          return null
        }
        c.cancels.push(stopAdmission)
        this.schedule(c)
        return this.live(c)
          ? { handle: browser.handle, challenge: structuredClone(challenge) }
          : null
      } catch {
        this.close(c)
        return null
      }
    } catch {
      return null
    } finally {
      try {
        cancel()
      } catch {}
      this.pending.delete(abandon)
      if (!transferred) abandon()
      this.allocating--
    }
  }
  async attachConnector(
    handle: PauseSignallingHandle,
    endpoint: PauseSignallingEndpoint,
    token: string,
    lifetime: { expiresAt: number; monotonicDeadline: number },
  ): Promise<
    | {
        kind: 'challenge'
        handle: PauseSignallingHandle
        challenge: CredentialProofChallenge
      }
    | { kind: 'busy'; retryAfterMs: number }
    | null
  > {
    const found = this.find(handle)
    if (!found || found.peer.role !== 'browser') return null
    const c = found.context
    if (
      !this.live(c) ||
      c.connector ||
      c.admitted ||
      endpoint.purpose !== 'pause' ||
      typeof token !== 'string' ||
      !token.length ||
      Buffer.byteLength(token) > 8192
    )
      return null
    if (
      !Number.isSafeInteger(lifetime.expiresAt) ||
      !Number.isFinite(lifetime.monotonicDeadline) ||
      lifetime.expiresAt <= c.snapshot.budget.observedAt
    ) {
      this.close(c)
      return null
    }
    let peer: Peer | null = null
    let work = false
    try {
      c.deadline = Math.min(c.deadline, lifetime.expiresAt)
      c.deadlineMono = Math.min(c.deadlineMono, lifetime.monotonicDeadline)
      c.admissionMono = Math.min(c.admissionMono, c.deadlineMono)
      peer = this.peer('connector', endpoint)
      peer.busy = true
      c.connector = peer
      this.handles.set(peer.handle, { context: c, peer })
      this.arm(c, c.browser)
      if (!this.live(c)) return null
      this.arm(c, peer)
      if (!this.live(c) || !this.takeCrypto()) {
        this.close(c)
        return null
      }
      work = true
      const result = await this.credentials.issue({
        token,
        agentId: c.snapshot.authority.agent_id,
        farmId: c.snapshot.authority.farm_id,
        connectionId: c.id,
      })
      if (!this.live(c)) return null
      if (!result.ok && result.reason === 'busy') {
        if (
          !Number.isSafeInteger(result.retryAfterMs) ||
          result.retryAfterMs < 1 ||
          result.retryAfterMs >= c.admissionMono - this.clock.monotonic() ||
          !this.live(c)
        ) {
          this.close(c)
          return null
        }
        this.handles.delete(peer.handle)
        c.connector = null
        try {
          peer.cancel()
        } catch {
          this.close(c)
        }
        // Runtime still owns the inbox endpoint; a definite busy response has not attached it.
        return this.live(c)
          ? { kind: 'busy', retryAfterMs: result.retryAfterMs }
          : null
      }
      if (!result.ok || result.kind !== 'challenge') {
        this.close(c)
        return null
      }
      const ch = CredentialProofChallenge.parse(result.challenge),
        a = c.snapshot.authority
      const key = await connectorKeyBinding(a.connector_public_key_spki)
      if (
        !this.live(c) ||
        ch.purpose !== 'signalling' ||
        ch.connection_id !== c.id ||
        ch.agent_id !== a.agent_id ||
        ch.farm_id !== a.farm_id ||
        ch.jti !== a.credential_jti ||
        ch.origin !== a.origin ||
        ch.audience !== this.credentialAudience ||
        ch.public_key_spki !== a.connector_public_key_spki ||
        ch.fingerprint !== a.connector_fingerprint ||
        ch.thumbprint !== key.thumbprint ||
        ch.token_hash !==
          createHash('sha256').update(token).digest('base64url') ||
        ch.issued_at > this.clock.wall() + 250 ||
        ch.expires_at <= this.clock.wall() ||
        !this.live(c)
      ) {
        this.close(c)
        return null
      }
      c.credentialChallenge = structuredClone(ch)
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
      if (peer) peer.busy = false
      if (work) this.cryptoTasks--
    }
  }
  async prove(
    handle: PauseSignallingHandle,
    signature: unknown,
  ): Promise<boolean> {
    const found = this.find(handle)
    if (!found) return false
    const { context: c, peer } = found
    if (!this.live(c) || peer.proved || peer.busy || !this.takeCrypto())
      return false
    peer.busy = true
    try {
      let valid = false,
        expires = c.challenge.expires_at
      if (peer.role === 'browser')
        valid = await verifyPauseTransportProof(
          c.challenge,
          c.snapshot.authority.browser_public_key,
          signature,
        )
      else if (c.credentialChallenge && c.token) {
        expires = c.credentialChallenge.expires_at
        const accepted = await acceptSignallingProof({
          credentials: this.credentials,
          clock: this.clock,
          timers: this.timers,
          deadline: Math.min(c.admissionMono, c.deadlineMono),
          signal: c.abort.signal,
          request: {
            token: c.token,
            agentId: c.snapshot.authority.agent_id,
            farmId: c.snapshot.authority.farm_id,
            connectionId: c.id,
            challenge: c.credentialChallenge,
            signature,
          },
        })
        c.token = null
        valid =
          accepted.ok &&
          accepted.kind === 'accepted' &&
          accepted.purpose === 'signalling' &&
          accepted.agentId === c.snapshot.authority.agent_id &&
          accepted.farmId === c.snapshot.authority.farm_id &&
          accepted.jti === c.snapshot.authority.credential_jti &&
          accepted.connectionId === c.id &&
          Number.isSafeInteger(accepted.acceptedAt) &&
          accepted.acceptedAt >= c.credentialChallenge.issued_at &&
          accepted.acceptedAt <= this.clock.wall() + 250 &&
          Number.isSafeInteger(accepted.expiresAt) &&
          accepted.expiresAt <= c.credentialChallenge.expires_at &&
          accepted.expiresAt > accepted.acceptedAt &&
          accepted.expiresAt > this.clock.wall()
        if (valid && accepted.ok && accepted.kind === 'accepted')
          expires = Math.min(expires, accepted.expiresAt)
      }
      if (
        !this.live(c) ||
        !valid ||
        !(await this.revalidate(c, expires)) ||
        !this.live(c)
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
  describe(handle: PauseSignallingHandle) {
    const found = this.find(handle)
    if (!found || !this.live(found.context)) return null
    const c = found.context,
      a = c.snapshot.authority
    return Object.freeze({
      purpose: 'pause' as const,
      transportId: c.id,
      farmId: a.farm_id,
      agentId: a.agent_id,
      assignmentId: a.assignment_id,
      jti: a.credential_jti,
      issuedAt: c.snapshot.budget.observedAt,
      expiresAt: c.deadline,
      admissionExpiresAt: c.challenge.expires_at,
      admitted: c.admitted,
      bound: c.bound,
    })
  }
  relay(handle: PauseSignallingHandle, wire: unknown): Promise<boolean> {
    const found = this.find(handle)
    if (!found || !this.live(found.context) || !found.context.admitted)
      return Promise.resolve(false)
    const { context: c, peer } = found
    if (
      typeof wire !== 'string' ||
      Buffer.byteLength(wire) > 8192 ||
      c.outstanding >= 4 ||
      c.bytes + Buffer.byteLength(wire) > 32768
    ) {
      this.close(c)
      return Promise.resolve(false)
    }
    c.outstanding++
    c.bytes += Buffer.byteLength(wire)
    return new Promise((resolve) => {
      c.queue.push({ peer, wire, bytes: Buffer.byteLength(wire), resolve })
      void this.pump(c)
    })
  }
  closeHandle(handle: PauseSignallingHandle): void {
    const found = this.find(handle)
    if (found) this.close(found.context)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const abandon of this.pending) abandon()
    for (const c of this.contexts) this.close(c)
  }
  private find(handle: PauseSignallingHandle) {
    return handle instanceof ControlHandle && handle.belongsTo(this)
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
          if (
            frame.transport_id !== c.id ||
            frame.seq !== item.peer.seq ||
            !(await this.revalidate(c)) ||
            !this.live(c)
          )
            throw Error('Denied metadata')
          item.peer.seq++
          const other = item.peer.role === 'browser' ? c.connector : c.browser
          if (!other) throw Error('Missing peer')
          switch (frame.t) {
            case 'rtc.close':
              this.close(c)
              break
            case 'rtc.offer':
              if (item.peer.role !== 'connector' || c.offer || c.bound)
                throw Error('Offer order')
              c.offer = frame.p.sdp
              break
            case 'rtc.answer':
              if (
                item.peer.role !== 'browser' ||
                !c.offer ||
                c.answer ||
                c.bound
              )
                throw Error('Answer order')
              c.answer = frame.p.sdp
              break
            case 'rtc.ice':
              if (!c.offer || ++item.peer.ice > 64) throw Error('ICE order')
              break
          }
          if (!this.live(c)) break
          other.endpoint.send(item.wire)
          if (!this.live(c)) break
          if (frame.t === 'rtc.answer') {
            if (
              !c.offer ||
              !c.answer ||
              !c.credentialChallenge ||
              !this.takeCrypto()
            )
              throw Error('Binding unavailable')
            let offerHash: string, answerHash: string
            try {
              offerHash = await controlSdpHash(c.offer)
              if (!this.live(c)) break
              answerHash = await controlSdpHash(c.answer)
            } finally {
              this.cryptoTasks--
            }
            if (!this.live(c) || !(await this.revalidate(c)) || !this.live(c))
              throw Error('Changed binding authority')
            const {
              role: _,
              validUntil: __,
              ...authority
            } = c.snapshot.authority
            const binding = ControlSessionBinding.parse({
              ...authority,
              v: 1,
              purpose: 'pause-rtc',
              transport_id: c.id,
              browser_nonce: c.challenge.nonce,
              connector_nonce: c.credentialChallenge.nonce,
              issued_at: c.snapshot.budget.observedAt,
              expires_at: c.deadline,
              offer_sha256: offerHash,
              answer_sha256: answerHash,
              browser_dtls: controlDtlsFingerprint(c.answer),
              connector_dtls: controlDtlsFingerprint(c.offer),
            })
            c.bound = true
            if (!this.live(c)) break
            c.browser.endpoint.bindControl(structuredClone(binding))
            if (!this.live(c)) break
            c.connector?.endpoint.bindControl(structuredClone(binding))
          }
          success = this.live(c)
        } catch {
          this.close(c)
        } finally {
          c.outstanding--
          c.bytes -= item.bytes
          item.resolve(success && !c.closed)
        }
      }
    } finally {
      c.active = false
    }
  }
  private async read(scope: PauseNegotiationScope): Promise<Snapshot | null> {
    if (this.disposed || this.authorityTasks >= 8) return null
    this.authorityTasks++
    try {
      const parsed = Snapshot.safeParse(await this.authority.read(scope))
      return parsed.success ? parsed.data : null
    } finally {
      this.authorityTasks--
    }
  }
  private matches(scope: PauseNegotiationScope, snapshot: Snapshot) {
    const a = snapshot.authority
    return (
      scope.farmId === a.farm_id &&
      scope.agentId === a.agent_id &&
      scope.keyId === a.key_id &&
      scope.assignmentId === a.assignment_id &&
      snapshot.budget.validUntil === a.validUntil &&
      snapshot.budget.observedAt < a.validUntil
    )
  }
  private pins(snapshot: Snapshot) {
    const { validUntil: _, ...pins } = snapshot.authority
    return canonicalize({ ...pins, printerKey: snapshot.printerKey })
  }
  private async revalidate(c: Context, proofExpiry?: number): Promise<boolean> {
    if (!this.live(c)) return false
    try {
      const snapshot = await this.read(c.scope)
      if (
        !this.live(c) ||
        !snapshot ||
        !this.matches(c.scope, snapshot) ||
        this.pins(snapshot) !== c.pins ||
        snapshot.budget.observedAt < c.snapshot.budget.observedAt ||
        snapshot.budget.observedAt >= c.deadline ||
        (proofExpiry !== undefined && snapshot.budget.observedAt >= proofExpiry)
      )
        return false
      const timing = signallingRemaining({
        anchor: c.start,
        now: signallingClockSample(this.clock),
        authorization: snapshot.budget,
        previousDeadline: c.deadlineMono,
      })
      if (!this.live(c)) return false
      c.snapshot = snapshot
      c.deadline = Math.min(c.deadline, snapshot.authority.validUntil)
      if (timing.monotonicDeadline < c.deadlineMono) {
        c.deadlineMono = timing.monotonicDeadline
        c.admissionMono = Math.min(c.admissionMono, c.deadlineMono)
        this.arm(c, c.browser)
        if (!this.live(c)) return false
        if (c.connector) this.arm(c, c.connector)
      }
      return this.live(c)
    } catch {
      return false
    }
  }
  private arm(c: Context, peer: Peer): void {
    const cancel = peer.cancel
    peer.cancel = () => {}
    cancel()
    if (!this.live(c)) return
    const next = peer.endpoint.armDeadline(
      Math.max(0, c.deadlineMono - this.clock.monotonic()),
      () => this.close(c),
    )
    if (c.closed) next()
    else peer.cancel = next
  }
  private schedule(c: Context): void {
    if (!this.live(c)) return
    const cancel = this.timers.after(5000, () => {
      c.revalidationCancel = null
      void this.revalidate(c)
        .then((ok) => {
          if (!ok) this.close(c)
          else this.schedule(c)
        })
        .catch(() => this.close(c))
    })
    if (c.closed) cancel()
    else c.revalidationCancel = cancel
  }
  private live(c: Context): boolean {
    if (c.closed || this.disposed) {
      this.close(c)
      return false
    }
    try {
      const now = signallingClockSample(this.clock)
      if (
        c.closed ||
        this.disposed ||
        now.wall < c.last.wall ||
        now.monotonic < c.last.monotonic ||
        Math.abs(
          now.wall - c.start.wall - (now.monotonic - c.start.monotonic),
        ) > 250 ||
        now.monotonic >= c.deadlineMono ||
        now.wall >= c.deadline ||
        (!c.admitted && now.monotonic >= c.admissionMono)
      ) {
        this.close(c)
        return false
      }
      c.last = now
      return true
    } catch {
      this.close(c)
      return false
    }
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
    c.token = null
    for (const peer of [c.browser, c.connector])
      if (peer) this.handles.delete(peer.handle)
    try {
      c.abort.abort()
    } catch {}
    const queue = c.queue.splice(0)
    for (const item of queue) {
      c.outstanding--
      c.bytes -= item.bytes
      item.resolve(false)
    }
    const cancels = c.cancels.splice(0)
    if (c.revalidationCancel) cancels.push(c.revalidationCancel)
    c.revalidationCancel = null
    for (const peer of [c.browser, c.connector])
      if (peer) {
        cancels.push(peer.cancel)
        peer.cancel = () => {}
      }
    for (const cancel of cancels)
      try {
        cancel()
      } catch {}
    for (const peer of [c.browser, c.connector])
      if (peer)
        try {
          peer.endpoint.close()
        } catch {}
  }
}
