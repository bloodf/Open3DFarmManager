export const AUDIT_ACTIONS = [
  'job.submitted',
  'printer.action',
  'approval.decided',
  'connector.result',
  'subscription.changed',
  'credential.event',
] as const
export type IntegrationAuditAction = (typeof AUDIT_ACTIONS)[number]
export type IntegrationAuditOutcome =
  | 'accepted'
  | 'held'
  | 'approved'
  | 'rejected'
  | 'succeeded'
  | 'failed'
  | 'revoked'
  | 'created'
  | 'refused'
  | 'unknown'
export interface IntegrationAuditEntry {
  id: string
  farmId: string
  appId: string | null
  printerAssignmentId: string | null
  actorKind: 'app' | 'owner' | 'connector' | 'system'
  actorId: string | null
  action: IntegrationAuditAction
  resourceType:
    'job' | 'action' | 'approval' | 'connector' | 'subscription' | 'credential'
  resourceId: string | null
  outcome: IntegrationAuditOutcome
  occurredAt: number
  details: Record<string, string | number | boolean | null>
}
export interface IntegrationAuditFilter {
  farmId: string
  appId?: string
  printerAssignmentId?: string
  beforeId?: string
  limit?: number
}
export interface IntegrationAuditStore {
  append(
    input: Omit<IntegrationAuditEntry, 'id'>,
  ): Promise<IntegrationAuditEntry>
  listForOwner(
    actorId: string,
    filter: IntegrationAuditFilter,
  ): Promise<IntegrationAuditEntry[] | null>
}
const safeDetailKeys = new Set([
  'status',
  'count',
  'actionName',
  'approvalDecision',
  'resultCode',
  'refusalCode',
  'jobStatus',
  'subscriptionEvent',
  'credentialEvent',
])
export function safeAuditDetails(
  value: unknown,
): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      ([key, item]) =>
        safeDetailKeys.has(key) &&
        (item === null ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)) ||
          (typeof item === 'string' && item.length <= 128)),
    )
    .slice(0, 16)
  return Object.fromEntries(entries) as Record<
    string,
    string | number | boolean | null
  >
}
export class IntegrationAuditService {
  private readonly store: IntegrationAuditStore
  private readonly now: () => number
  constructor(store: IntegrationAuditStore, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }
  record(
    input: Omit<IntegrationAuditEntry, 'id' | 'occurredAt' | 'details'> & {
      occurredAt?: number
      details?: unknown
    },
  ) {
    return this.store.append({
      ...input,
      occurredAt: input.occurredAt ?? this.now(),
      details: safeAuditDetails(input.details),
    })
  }
  listForOwner(actorId: string, filter: IntegrationAuditFilter) {
    return this.store.listForOwner(actorId, filter)
  }
}
