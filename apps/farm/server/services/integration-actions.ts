import { createHash, randomUUID } from 'node:crypto'
import {
  API_ENVELOPE_ACTIONS,
  type ApiEnvelopeAction,
} from '../../../../packages/farm-protocol/src/api-envelope.ts'
import { ControlArguments } from '../../../../packages/farm-protocol/src/control-actions.ts'
import type {
  EnvelopeRecord,
  IssueEnvelope,
  IssueResult,
  DeliveryResult,
} from './integration-delivery.ts'
import { integrationGrantFor } from '../utils/integration-auth-http.ts'
import type { IntegrationScope } from './integration-apps.ts'
import { HELD_TTL_MS, IDEMPOTENCY_KEY_PATTERN } from './integration-jobs.ts'
import {
  uuidPattern,
  type IntegrationPrincipal,
} from '../utils/integration-auth.ts'

export type ActionTarget = {
  farmId: string
  agentId: string
  controls: readonly string[]
}
export type StoredActionStatus = 'held' | 'submitted' | 'rejected' | 'expired'
export interface NewAction {
  id: string
  appId: string
  grantId: string
  farmId: string
  printerAssignmentId: string
  idempotencyKey: string
  requestHash: string
  action: ApiEnvelopeAction
  requiredScope: Extract<IntegrationScope, 'control:basic' | 'control:extended'>
  status: 'held' | 'submitted'
}
export interface ActionRecord extends Omit<NewAction, 'status'> {
  status: StoredActionStatus
  createdAt: number
  updatedAt: number
}
export type CreateActionOutcome =
  | { kind: 'created'; record: ActionRecord }
  | { kind: 'existing'; record: ActionRecord; cmdId: string | null }
  | { kind: 'refused' }
export interface IntegrationActionsStore {
  target(printerAssignmentId: string): Promise<ActionTarget | null>
  create(action: NewAction, now: number): Promise<CreateActionOutcome>
  existing(
    appId: string,
    idempotencyKey: string,
  ): Promise<{ record: ActionRecord; envelope: EnvelopeRecord | null } | null>
  get(
    id: string,
    appId: string,
  ): Promise<{ record: ActionRecord; envelope: EnvelopeRecord | null } | null>
}
export interface ActionEnvelopes {
  issue(input: IssueEnvelope): Promise<IssueResult>
  deliver(cmdId: string): Promise<DeliveryResult>
  get(cmdId: string): Promise<EnvelopeRecord | null>
}

export type ActionProblem =
  | 'validation-failed'
  | 'unsupported'
  | 'insufficient-scope'
  | 'not-found'
  | 'idempotency-key-reused'
  | 'service-unavailable'
export type ActionStatus =
  | 'held'
  | 'rejected'
  | 'queued'
  | 'expired'
  | 'delivered'
  | 'refused'
  | 'completed'
  | 'failed'
  | 'outcome-unknown'
export interface ActionView {
  id: string
  farmId: string
  printerId: string
  action: string
  args: Record<string, unknown>
  status: ActionStatus
  createdAt: number
  updatedAt: number
  refusal?: { code: string; detail?: string }
}
export type SubmitActionResult =
  | { ok: true; created: boolean; action: ActionView }
  | { ok: false; problem: ActionProblem }

const CONTROL_BASIC = new Set(['pause', 'resume', 'cancel'])
const DEFAULT_ACTION_TTL_MS = 300_000
const PENDING: readonly string[] = ['pending', 'sending', 'sent']

export function parseActionRequest(body: unknown): ApiEnvelopeAction | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const input = body as Record<string, unknown>
  let candidate = input
  if (
    input.action === 'set_temperature' &&
    input.args &&
    typeof input.args === 'object' &&
    !Array.isArray(input.args)
  ) {
    const argsInput = input.args as Record<string, unknown>
    if ('target_c' in argsInput || !('targetCelsius' in argsInput)) return null
    const { targetCelsius, ...args } = argsInput
    candidate = { ...input, args: { ...args, target_c: targetCelsius } }
  }
  const parsed = ControlArguments.safeParse(candidate)
  if (
    !parsed.success ||
    !API_ENVELOPE_ACTIONS.includes(parsed.data.action as never)
  )
    return null
  return parsed.data as ApiEnvelopeAction
}

export function actionRequestHash(
  printerId: string,
  action: ApiEnvelopeAction,
) {
  return createHash('sha256')
    .update(JSON.stringify([printerId, action]))
    .digest('hex')
}

function statusOf(
  stored: StoredActionStatus,
  envelope: EnvelopeRecord | null,
  heldExpired: boolean,
): ActionStatus {
  if (stored === 'held' && heldExpired) return 'expired'
  if (stored !== 'submitted') return stored
  if (!envelope || PENDING.includes(envelope.status)) return 'queued'
  return envelope.status as ActionStatus
}

export function actionView(
  record: ActionRecord,
  envelope: EnvelopeRecord | null,
  now?: number,
): ActionView {
  const args =
    record.action.action === 'set_temperature'
      ? {
          heater: record.action.args.heater,
          targetCelsius: record.action.args.target_c,
        }
      : record.action.args
  const view: ActionView = {
    id: record.id,
    farmId: record.farmId,
    printerId: record.printerAssignmentId,
    action: record.action.action,
    args: args as Record<string, unknown>,
    status: statusOf(
      record.status,
      envelope,
      now !== undefined && now >= record.createdAt + HELD_TTL_MS,
    ),
    createdAt: record.createdAt,
    updatedAt: Math.max(record.updatedAt, envelope?.updatedAt ?? 0),
  }
  if (envelope?.refusalCode)
    view.refusal = {
      code: envelope.refusalCode,
      ...(envelope.resultDetail ? { detail: envelope.resultDetail } : {}),
    }
  return view
}

export class IntegrationActionsService {
  private readonly options: {
    store: IntegrationActionsStore
    envelopes?: ActionEnvelopes
    now: () => number
    ttlMs: number
  }
  constructor(options: {
    store: IntegrationActionsStore
    envelopes?: ActionEnvelopes
    now?: () => number
    ttlMs?: number
  }) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      ttlMs: options.ttlMs ?? DEFAULT_ACTION_TTL_MS,
    }
  }

  async submit(
    principal: IntegrationPrincipal,
    printerId: string,
    key: string,
    body: unknown,
  ): Promise<SubmitActionResult> {
    const printer = printerId.toLowerCase()
    if (!uuidPattern.test(printer)) return { ok: false, problem: 'not-found' }
    if (!IDEMPOTENCY_KEY_PATTERN.test(key))
      return { ok: false, problem: 'validation-failed' }
    const action = parseActionRequest(body)
    if (!action) return { ok: false, problem: 'validation-failed' }
    if (action.action === 'start_library_print')
      return { ok: false, problem: 'unsupported' }
    const requiredScope = (
      CONTROL_BASIC.has(action.action) ? 'control:basic' : 'control:extended'
    ) as NewAction['requiredScope']
    if (!principal.scopes.includes(requiredScope))
      return { ok: false, problem: 'insufficient-scope' }
    const requestHash = actionRequestHash(printer, action)
    const prior = await this.options.store.existing(principal.appId, key)
    if (prior) {
      if (prior.record.requestHash !== requestHash)
        return { ok: false, problem: 'idempotency-key-reused' }
      if (
        !integrationGrantFor(
          principal,
          prior.record.requiredScope,
          prior.record.farmId,
          prior.record.printerAssignmentId,
        )
      )
        return { ok: false, problem: 'not-found' }
      if (prior.record.status !== 'submitted' || prior.envelope)
        return {
          ok: true,
          created: false,
          action: actionView(prior.record, prior.envelope),
        }
    }
    const target = await this.options.store.target(printer)
    if (!target) return { ok: false, problem: 'not-found' }
    const grant = integrationGrantFor(
      principal,
      requiredScope,
      target.farmId,
      printer,
    )
    if (!grant) return { ok: false, problem: 'not-found' }
    if (!target.controls.includes(action.action))
      return { ok: false, problem: 'unsupported' }
    if (!grant.requiresApproval && !this.options.envelopes)
      return { ok: false, problem: 'service-unavailable' }
    const outcome = await this.options.store.create(
      {
        id: randomUUID(),
        appId: principal.appId,
        grantId: grant.id,
        farmId: target.farmId,
        printerAssignmentId: printer,
        idempotencyKey: key,
        requestHash,
        action,
        requiredScope,
        status: grant.requiresApproval ? 'held' : 'submitted',
      },
      this.options.now(),
    )
    if (outcome.kind === 'refused')
      return { ok: false, problem: 'insufficient-scope' }
    const created = outcome.kind === 'created'
    const record = outcome.record
    if (!created && record.requestHash !== requestHash)
      return { ok: false, problem: 'idempotency-key-reused' }
    if (record.status !== 'submitted')
      return { ok: true, created, action: actionView(record, null) }
    const envelopes = this.options.envelopes
    if (!envelopes) return { ok: false, problem: 'service-unavailable' }
    let envelope: EnvelopeRecord | null = null
    let deliver = false
    if (!created && outcome.cmdId) envelope = await envelopes.get(outcome.cmdId)
    else {
      const issued = await envelopes.issue({
        appId: record.appId,
        grantId: record.grantId,
        farmId: record.farmId,
        agentId: target.agentId,
        printerAssignmentId: record.printerAssignmentId,
        resourceId: record.id,
        ttlMs: this.options.ttlMs,
        command: { kind: 'action', action: record.action },
      })
      if (!issued.ok)
        return {
          ok: false,
          problem:
            issued.reason === 'invalid'
              ? 'validation-failed'
              : 'insufficient-scope',
        }
      envelope = issued.record
      deliver = issued.created
    }
    if (deliver && envelope) {
      try {
        await envelopes.deliver(envelope.cmdId)
        envelope = (await envelopes.get(envelope.cmdId)) ?? envelope
      } catch {
        /* A stored envelope is never resent after an uncertain write. */
      }
    }
    return { ok: true, created, action: actionView(record, envelope) }
  }

  async get(principal: IntegrationPrincipal, actionId: string) {
    if (!uuidPattern.test(actionId)) return { error: 'not-found' as const }
    const result = await this.options.store.get(actionId, principal.appId)
    if (!result) return { error: 'not-found' as const }
    if (!principal.scopes.includes(result.record.requiredScope))
      return { error: 'insufficient-scope' as const }
    if (
      !integrationGrantFor(
        principal,
        result.record.requiredScope,
        result.record.farmId,
        result.record.printerAssignmentId,
      )
    )
      return { error: 'not-found' as const }
    return actionView(result.record, result.envelope, this.options.now())
  }
}
