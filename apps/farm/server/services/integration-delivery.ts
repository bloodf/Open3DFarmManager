import { randomUUID } from 'node:crypto'
import {
  API_ENVELOPE_ISSUER,
  type ApiEnvelopeJob,
  MAX_API_ENVELOPE_TTL_MS,
  MIN_API_ENVELOPE_TTL_MS,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
  type ApiEnvelopeAction,
  type ApiEnvelopeRefusalCode,
} from '../../../../packages/farm-protocol/src/api-envelope.ts'
import type {
  IntegrationAuditOutcome,
  IntegrationAuditService,
} from './integration-audit.ts'

/**
 * Delivers API jobs and actions to a Connector as signed envelopes.
 *
 * Delivery is at most once. An envelope is claimed (`pending` -> `sending`)
 * before it is written to the inbox and a claim is never repeated. Only one
 * outcome proves nothing was sent (no live inbox socket), and only that
 * outcome returns the envelope to `pending`. A write that threw, or a result
 * that never arrived before expiry, ends as `outcome-unknown` and is never
 * resent. An envelope nobody claimed before it expires ends as `expired`.
 */
export type EnvelopeStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'refused'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'expired'
  | 'rejected'
  | 'outcome-unknown'
export type EnvelopeKind = 'job' | 'action'
export type RequiredScope = 'jobs:start' | 'control:basic' | 'control:extended'
/** What the Connector can report, in the order a command can progress. */
export type ConnectorOutcome =
  'delivered' | 'refused' | 'started' | 'completed' | 'cancelled' | 'failed'

export interface EnvelopeRecord {
  cmdId: string
  appId: string
  grantId: string
  farmId: string
  agentId: string
  printerAssignmentId: string
  kind: EnvelopeKind
  resourceId: string
  requiredScope: RequiredScope
  nonce: string
  wire: string
  issuedAt: number
  expiresAt: number
  status: EnvelopeStatus
  refusalCode: ApiEnvelopeRefusalCode | null
  resultDetail: string | null
  historyEntryId: string | null
  createdAt: number
  updatedAt: number
}
export type NewEnvelope = Omit<
  EnvelopeRecord,
  | 'status'
  | 'refusalCode'
  | 'resultDetail'
  | 'historyEntryId'
  | 'createdAt'
  | 'updatedAt'
>
export interface EnvelopeResult {
  refusalCode?: ApiEnvelopeRefusalCode | undefined
  detail?: string | undefined
  historyEntryId?: string | undefined
}
export type InsertOutcome =
  | { kind: 'created'; record: EnvelopeRecord }
  /** The API resource already has its envelope; a retry never gets a second command. */
  | { kind: 'existing'; record: EnvelopeRecord }
  /** The grant, scope, assignment or sandbox rule no longer allows the command. */
  | { kind: 'refused' }
export interface IntegrationDeliveryStore {
  insert(envelope: NewEnvelope, now: number): Promise<InsertOutcome>
  get(cmdId: string): Promise<EnvelopeRecord | null>
  /** Oldest unexpired pending envelopes of one agent. */
  listPending(
    farmId: string,
    agentId: string,
    now: number,
    limit: number,
  ): Promise<EnvelopeRecord[]>
  /**
   * Compare-and-set `pending` -> `sending`. Succeeds only while the envelope is
   * unexpired and its app, grant and assignment are still active.
   */
  claim(cmdId: string, now: number): Promise<EnvelopeRecord | null>
  /**
   * Moves a `pending` envelope that cannot be claimed to its final state:
   * `expired` after its expiry, `rejected` once its authority is gone.
   */
  settleUnclaimable(cmdId: string, now: number): Promise<EnvelopeRecord | null>
  /** Compare-and-set from one of `from`; `null` when the status is not one of them. */
  transition(
    cmdId: string,
    from: readonly EnvelopeStatus[],
    to: EnvelopeStatus,
    now: number,
    result?: EnvelopeResult,
  ): Promise<EnvelopeRecord | null>
  /**
   * Pending envelopes past their expiry become `expired`; envelopes handed to
   * the inbox (or claimed) but never confirmed by then become `outcome-unknown`.
   */
  sweep(now: number, limit: number): Promise<EnvelopeRecord[]>
}
/** `no-inbox`: no live authenticated socket, so nothing was written. A throw is an uncertain write. */
export interface EnvelopeInbox {
  bindApiDelivery?(
    delivery: Pick<
      IntegrationDeliveryService,
      'deliverPending' | 'recordResult'
    >,
  ): void
  sendToAgentInbox(
    farmId: string,
    agentId: string,
    wire: string,
    authority: { scope: RequiredScope; confirmedAt: number },
  ): 'sent' | 'no-inbox'
}
export interface IssueEnvelope {
  appId: string
  grantId: string
  farmId: string
  agentId: string
  printerAssignmentId: string
  /** The API job or action id. */
  resourceId: string
  /** Validity of an undelivered envelope. */
  ttlMs: number
  command:
    | { kind: 'job'; job: ApiEnvelopeJob }
    | { kind: 'action'; action: ApiEnvelopeAction }
}
export type IssueResult =
  | { ok: true; record: EnvelopeRecord; created: boolean }
  | { ok: false; reason: 'invalid' | 'refused' }
export type DeliveryResult = 'sent' | 'no-inbox' | 'uncertain' | EnvelopeStatus
export type ResultVerdict =
  'recorded' | 'duplicate' | 'ignored' | 'unknown-command'
export type DeliveryErrorSite = 'audit' | 'store' | 'inbox'

const CONTROL_BASIC = new Set(['pause', 'resume', 'cancel'])
/** Statuses a Connector outcome may follow; a final status never changes. */
const OUTCOME_FROM: Record<ConnectorOutcome, readonly EnvelopeStatus[]> = {
  delivered: ['sending', 'sent'],
  refused: ['sending', 'sent'],
  started: ['sending', 'sent', 'delivered'],
  completed: ['sending', 'sent', 'delivered', 'started'],
  cancelled: ['sending', 'sent', 'delivered', 'started'],
  failed: ['sending', 'sent', 'delivered', 'started'],
}
const ACTION_OUTCOMES = new Set<ConnectorOutcome>([
  'delivered',
  'refused',
  'completed',
  'failed',
])
const AUDIT_OUTCOME: Record<string, IntegrationAuditOutcome> = {
  sent: 'accepted',
  delivered: 'accepted',
  started: 'accepted',
  refused: 'refused',
  completed: 'succeeded',
  cancelled: 'failed',
  failed: 'failed',
  expired: 'failed',
  rejected: 'rejected',
  'outcome-unknown': 'unknown',
}
export function requiredScopeFor(
  command: IssueEnvelope['command'],
): RequiredScope {
  if (command.kind === 'job') return 'jobs:start'
  return CONTROL_BASIC.has(command.action.action)
    ? 'control:basic'
    : 'control:extended'
}

export type IntegrationDeliveryOptions = Readonly<{
  store: IntegrationDeliveryStore
  inbox: EnvelopeInbox
  audit: IntegrationAuditService
  /** The dedicated API issuer key: nonextractable Ed25519, distributed through the trusted-key set. */
  signer: Readonly<{ kid: string; signingKey: CryptoKey }>
  now?: () => number
  /** Failures never carry envelope contents. Defaults to silent. */
  onError?: (site: DeliveryErrorSite) => void
}>

export class IntegrationDeliveryService {
  private readonly o: IntegrationDeliveryOptions
  private readonly now: () => number
  /** Serialises delivery per agent so envelopes leave in order. */
  private readonly chains = new Map<string, Promise<unknown>>()
  constructor(options: IntegrationDeliveryOptions) {
    this.o = options
    this.now = options.now ?? Date.now
    options.inbox.bindApiDelivery?.(this)
  }
  private fail(site: DeliveryErrorSite) {
    try {
      this.o.onError?.(site)
    } catch {}
  }
  private async audit(
    record: EnvelopeRecord,
    status: string,
    actor: 'connector' | 'system',
    extra: Record<string, string> = {},
  ) {
    try {
      await this.o.audit.record({
        farmId: record.farmId,
        appId: record.appId,
        printerAssignmentId: record.printerAssignmentId,
        actorKind: actor,
        actorId: actor === 'connector' ? record.agentId : null,
        action: 'connector.result',
        resourceType: record.kind,
        resourceId: record.resourceId,
        outcome: AUDIT_OUTCOME[status] ?? 'unknown',
        details: { status, ...extra },
      })
    } catch {
      // The state change already committed and is never rolled back by an audit failure.
      this.fail('audit')
    }
  }

  /** Signs and stores one envelope. Delivery is a separate step so it can wait for an inbox. */
  async issue(input: IssueEnvelope): Promise<IssueResult> {
    const ttl = input.ttlMs
    if (
      !Number.isInteger(ttl) ||
      ttl < MIN_API_ENVELOPE_TTL_MS ||
      ttl > MAX_API_ENVELOPE_TTL_MS
    )
      return { ok: false, reason: 'invalid' }
    const issuedAt = this.now()
    const cmdId = randomUUID()
    const nonce = newApiEnvelopeNonce()
    let wire: string
    try {
      const envelope = await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: this.o.signer.kid,
          app_id: input.appId,
          grant_id: input.grantId,
          farm_id: input.farmId,
          agent_id: input.agentId,
          assignment_id: input.printerAssignmentId,
          resource_id: input.resourceId,
          cmd_id: cmdId,
          nonce,
          issued_at: issuedAt,
          expires_at: issuedAt + ttl,
          kind: input.command.kind,
          ...(input.command.kind === 'job'
            ? { job: input.command.job }
            : { action: input.command.action }),
        },
        this.o.signer.signingKey,
      )
      wire = encodeApiEnvelopeFrame({
        v: 1,
        t: 'api-envelope.command',
        envelope,
      })
    } catch {
      return { ok: false, reason: 'invalid' }
    }
    const outcome = await this.o.store.insert(
      {
        cmdId,
        appId: input.appId,
        grantId: input.grantId,
        farmId: input.farmId,
        agentId: input.agentId,
        printerAssignmentId: input.printerAssignmentId,
        kind: input.command.kind,
        resourceId: input.resourceId,
        requiredScope: requiredScopeFor(input.command),
        nonce,
        wire,
        issuedAt,
        expiresAt: issuedAt + ttl,
      },
      issuedAt,
    )
    if (outcome.kind === 'refused') return { ok: false, reason: 'refused' }
    return {
      ok: true,
      record: outcome.record,
      created: outcome.kind === 'created',
    }
  }

  /** At most one write to the inbox per envelope, ever. */
  async deliver(cmdId: string): Promise<DeliveryResult> {
    const now = this.now()
    const claimed = await this.o.store.claim(cmdId, now)
    if (!claimed) {
      const settled = await this.o.store.settleUnclaimable(cmdId, now)
      if (settled) {
        await this.audit(settled, settled.status, 'system')
        return settled.status
      }
      return (await this.o.store.get(cmdId))?.status ?? 'rejected'
    }
    let sent: 'sent' | 'no-inbox'
    try {
      sent = this.o.inbox.sendToAgentInbox(
        claimed.farmId,
        claimed.agentId,
        claimed.wire,
        { scope: claimed.requiredScope, confirmedAt: now },
      )
    } catch {
      // The write may have reached the Connector: never resend.
      this.fail('inbox')
      const unknown = await this.o.store.transition(
        cmdId,
        ['sending'],
        'outcome-unknown',
        this.now(),
      )
      if (unknown) await this.audit(unknown, 'outcome-unknown', 'system')
      return 'uncertain'
    }
    if (sent === 'no-inbox') {
      // Nothing left this process, so the claim can be retried while the envelope lives.
      await this.o.store.transition(cmdId, ['sending'], 'pending', this.now())
      return 'no-inbox'
    }
    const marked = await this.o.store.transition(
      cmdId,
      ['sending'],
      'sent',
      this.now(),
    )
    // A fast result may already have moved it past `sending`; either way it was sent.
    await this.audit(marked ?? claimed, 'sent', 'system')
    return 'sent'
  }

  /** Delivers the agent's waiting envelopes in order, e.g. when its inbox proves its credential. */
  deliverPending(
    farmId: string,
    agentId: string,
    limit = 16,
  ): Promise<DeliveryResult[]> {
    const key = `${farmId}\0${agentId}`
    const run = (this.chains.get(key) ?? Promise.resolve()).then(async () => {
      const results: DeliveryResult[] = []
      const waiting = await this.o.store.listPending(
        farmId,
        agentId,
        this.now(),
        limit,
      )
      for (const record of waiting) {
        const result = await this.deliver(record.cmdId)
        results.push(result)
        // No live inbox: the rest would fail the same way.
        if (result === 'no-inbox') break
      }
      return results
    })
    const settled = run.catch(() => {})
    this.chains.set(key, settled)
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
    return run
  }

  /** Expires unclaimed envelopes and ends unconfirmed deliveries as unknown. */
  async sweep(limit = 100): Promise<number> {
    const changed = await this.o.store.sweep(this.now(), limit)
    for (const record of changed)
      await this.audit(record, record.status, 'system')
    return changed.length
  }

  /**
   * Records what the Connector reported. `farmId` and `agentId` come from the
   * authenticated inbox socket, never from the frame, so a Connector can only
   * report on its own envelopes.
   */
  async recordResult(
    farmId: string,
    agentId: string,
    wire: unknown,
  ): Promise<ResultVerdict> {
    let frame
    try {
      frame = decodeApiEnvelopeResultFrame(wire)
    } catch {
      return 'ignored'
    }
    const current = await this.o.store.get(frame.cmd_id)
    if (!current || current.farmId !== farmId || current.agentId !== agentId)
      return 'unknown-command'
    const outcome = frame.outcome
    if (current.kind === 'action' && !ACTION_OUTCOMES.has(outcome))
      return 'ignored'
    if (current.status === outcome) return 'duplicate'
    const updated = await this.o.store.transition(
      current.cmdId,
      OUTCOME_FROM[outcome],
      outcome,
      this.now(),
      {
        refusalCode: frame.refusal_code,
        detail: frame.detail,
        historyEntryId: frame.history_entry_id,
      },
    )
    if (!updated) return 'ignored'
    await this.audit(updated, outcome, 'connector', {
      ...(current.kind === 'action' ? {} : { jobStatus: outcome }),
      ...(frame.refusal_code ? { resultCode: frame.refusal_code } : {}),
    })
    return 'recorded'
  }
}
