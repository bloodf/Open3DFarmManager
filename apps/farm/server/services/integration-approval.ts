import type {
  ApiEnvelopeAction,
  ApiEnvelopeJob,
} from '../../../../packages/farm-protocol/src/api-envelope.ts'
import type {
  DeliveryResult,
  EnvelopeRecord,
  IssueEnvelope,
  IssueResult,
} from './integration-delivery.ts'
import {
  DEFAULT_JOB_ENVELOPE_TTL_MS,
  HELD_TTL_MS,
  jobStatusOf,
  type JobStatus,
} from './integration-jobs.ts'

/**
 * Optional operator approval. A job or action submitted under a grant that
 * requires approval is stored `held` and never reaches the delivery path. An
 * operator with control rights approves or rejects it on the farm page.
 *
 * Approval is a compare-and-set from `held` to `submitted` in the store, so a
 * second approval, a rejection after approval and a decision after expiry all
 * lose. The approved item then gets its one signed envelope (one envelope per
 * resource, ever) and is delivered like any unattended item. Rejected and
 * expired items have no envelope and can never get one.
 */
export type ApprovalKind = 'job' | 'action'
export type ApprovalDecision = 'approve' | 'reject'
/** Roles that hold control rights. A viewer never decides. */
export const APPROVER_ROLES: readonly string[] = ['owner', 'admin', 'operator']

export interface HeldItem {
  kind: ApprovalKind
  id: string
  farmId: string
  appId: string
  appName: string
  grantId: string
  printerAssignmentId: string
  printerKey: string
  agentId: string
  /** The job's display name, or the action's name. */
  summary: string
  createdAt: number
  expiresAt: number
  /** The payload of the signed envelope, never shown in a listing. */
  command:
    | { kind: 'job'; job: ApiEnvelopeJob }
    | { kind: 'action'; action: ApiEnvelopeAction }
}
/** What an operator sees: no file URL and no command payload beyond the summary. */
export type HeldItemView = Omit<HeldItem, 'command' | 'agentId' | 'grantId'>

export type DecideOutcome =
  /** The item moved out of `held` to the decision just made. */
  | { kind: 'decided'; item: HeldItem; decision: ApprovalDecision }
  /** The hold window had passed: the item is now `expired`. */
  | { kind: 'expired'; item: HeldItem }
  /** The app, grant or printer lost its authority while held: the item is now `rejected`. */
  | { kind: 'authority-lost'; item: HeldItem }
  /** The library version was removed while held: the item is now `rejected`. */
  | { kind: 'version-unavailable'; item: HeldItem }
  /** Someone else already decided it, or it was not held. */
  | { kind: 'conflict' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
export interface IntegrationApprovalStore {
  /** Held, unexpired items of the farm; `null` when the account holds no control rights there. */
  list(
    accountId: string,
    farmId: string,
    now: number,
    limit: number,
  ): Promise<HeldItem[] | null>
  /**
   * One transaction: checks the account's role, locks the held item, applies
   * the decision and writes its `approval.decided` audit entry.
   */
  decide(input: {
    accountId: string
    farmId: string
    id: string
    decision: ApprovalDecision
    now: number
  }): Promise<DecideOutcome>
  /** Terminally rejects an approved item when its envelope cannot be issued. */
  rejectApproved(input: {
    kind: ApprovalKind
    id: string
    now: number
    reason: 'invalid' | 'refused'
  }): Promise<void>
  /** Held items past their window become `expired`, each with an audit entry. */
  expireHeld(now: number, limit: number): Promise<number>
}
export interface ApprovalEnvelopes {
  issue(input: IssueEnvelope): Promise<IssueResult>
  deliver(cmdId: string): Promise<DeliveryResult>
  get(cmdId: string): Promise<EnvelopeRecord | null>
}

export type ApprovalProblem =
  | 'validation-failed'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'expired'
  | 'authority-lost'
  | 'version-unavailable'
  | 'service-unavailable'
export interface DecisionView {
  kind: ApprovalKind
  id: string
  decision: ApprovalDecision
  status: JobStatus
}
export type ListApprovalsResult =
  { ok: true; items: HeldItemView[] } | { ok: false; problem: 'forbidden' }
export type DecideResult =
  { ok: true; result: DecisionView } | { ok: false; problem: ApprovalProblem }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function heldItemView(item: HeldItem): HeldItemView {
  const { command: _command, agentId: _agent, grantId: _grant, ...view } = item
  return view
}

export type IntegrationApprovalOptions = Readonly<{
  store: IntegrationApprovalStore
  /** Absent when no envelope signer is configured: items can only be rejected. */
  envelopes?: ApprovalEnvelopes
  envelopeTtlMs?: number
  now?: () => number
  /** Failures never carry item contents. Defaults to silent. */
  onError?: (site: 'deliver') => void
}>

export class IntegrationApprovalService {
  private readonly o: IntegrationApprovalOptions
  private readonly now: () => number
  constructor(options: IntegrationApprovalOptions) {
    this.o = options
    this.now = options.now ?? Date.now
  }

  async list(accountId: string, farmId: string): Promise<ListApprovalsResult> {
    if (!uuid.test(farmId)) return { ok: false, problem: 'forbidden' }
    const items = await this.o.store.list(
      accountId,
      farmId.toLowerCase(),
      this.now(),
      100,
    )
    if (!items) return { ok: false, problem: 'forbidden' }
    return { ok: true, items: items.map(heldItemView) }
  }

  async decide(
    accountId: string,
    farmId: string,
    id: string,
    decision: unknown,
  ): Promise<DecideResult> {
    if (decision !== 'approve' && decision !== 'reject')
      return { ok: false, problem: 'validation-failed' }
    if (!uuid.test(farmId) || !uuid.test(id))
      return { ok: false, problem: 'not-found' }
    // An approval that cannot be delivered would strand the item as submitted.
    if (decision === 'approve' && !this.o.envelopes)
      return { ok: false, problem: 'service-unavailable' }
    const outcome = await this.o.store.decide({
      accountId,
      farmId: farmId.toLowerCase(),
      id: id.toLowerCase(),
      decision,
      now: this.now(),
    })
    switch (outcome.kind) {
      case 'forbidden':
        return { ok: false, problem: 'forbidden' }
      case 'not-found':
        return { ok: false, problem: 'not-found' }
      case 'conflict':
        return { ok: false, problem: 'conflict' }
      case 'expired':
        return { ok: false, problem: 'expired' }
      case 'authority-lost':
        return { ok: false, problem: 'authority-lost' }
      case 'version-unavailable':
        return { ok: false, problem: 'version-unavailable' }
    }
    const item = outcome.item
    if (decision === 'reject')
      return {
        ok: true,
        result: { kind: item.kind, id: item.id, decision, status: 'rejected' },
      }
    return {
      ok: true,
      result: {
        kind: item.kind,
        id: item.id,
        decision,
        status: await this.release(item),
      },
    }
  }

  /** Expires held items nobody decided. Returns how many changed. */
  sweep(limit = 100) {
    return this.o.store.expireHeld(this.now(), limit)
  }

  /**
   * Hands an approved item to the delivery path. The envelope is unique per
   * resource, so a retry after a crash can never produce a second command.
   */
  private async release(item: HeldItem): Promise<JobStatus> {
    const envelopes = this.o.envelopes
    if (!envelopes) return 'queued'
    const issued = await envelopes.issue({
      appId: item.appId,
      grantId: item.grantId,
      farmId: item.farmId,
      agentId: item.agentId,
      printerAssignmentId: item.printerAssignmentId,
      resourceId: item.id,
      ttlMs: this.o.envelopeTtlMs ?? DEFAULT_JOB_ENVELOPE_TTL_MS,
      command: item.command,
    })
    if (!issued.ok) {
      await this.o.store.rejectApproved({
        kind: item.kind,
        id: item.id,
        now: this.now(),
        reason: issued.reason,
      })
      return 'rejected'
    }
    let envelope = issued.record
    if (issued.created) {
      try {
        await envelopes.deliver(envelope.cmdId)
        envelope = (await envelopes.get(envelope.cmdId)) ?? envelope
      } catch {
        try {
          this.o.onError?.('deliver')
        } catch {}
      }
    }
    return jobStatusOf('submitted', envelope)
  }
}

export { HELD_TTL_MS }
