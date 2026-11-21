import { createError } from 'nuxt/server'
import type { Sql } from 'postgres'
import { IntegrationLimits } from '../utils/integration-auth-limits.ts'
import {
  takeIntegrationRequestLimit,
  type IntegrationRateLimitConfig,
} from '../utils/integration-rate-limit.ts'
import {
  IntegrationAuditService,
  type IntegrationAuditEntry,
  type IntegrationAuditFilter,
} from './integration-audit.ts'
import { PostgresIntegrationAudit } from '../storage/integration-audit-postgres.ts'

const sharedReadLimits = new IntegrationLimits()

export interface ListIntegrationAuditDeps {
  accountId: string
  farmId: string
  query: {
    appId?: string
    printerId?: string
    before?: string
  }
  /** Shared integration pool; callers must not end it per request. */
  pool: Sql
  rateLimits?: IntegrationLimits
  rateLimitConfig?: IntegrationRateLimitConfig
  setHeaders?: (headers: Record<string, string>) => void
  /** Test seam; production uses PostgresIntegrationAudit against `pool`. */
  listForOwner?: (
    actorId: string,
    filter: IntegrationAuditFilter,
  ) => Promise<IntegrationAuditEntry[] | null>
}

export async function listIntegrationAudit(deps: ListIntegrationAuditDeps) {
  const { farmId, accountId, query } = deps
  if (!/^[0-9a-f-]{36}$/i.test(farmId))
    throw createError({ status: 404, message: 'Farm não encontrada.' })
  const appId = typeof query.appId === 'string' ? query.appId : undefined
  const printerId =
    typeof query.printerId === 'string' ? query.printerId : undefined
  const before = typeof query.before === 'string' ? query.before : undefined
  if (
    (appId && !/^[0-9a-f-]{36}$/i.test(appId)) ||
    (printerId && !/^[0-9a-f-]{36}$/i.test(printerId)) ||
    (before && !/^\d{1,19}$/.test(before))
  )
    throw createError({ status: 400, message: 'Filtros inválidos.' })

  const rate = takeIntegrationRequestLimit(
    deps.rateLimits ?? sharedReadLimits,
    accountId,
    'GET',
    deps.rateLimitConfig ?? {},
  )
  deps.setHeaders?.(rate.headers)
  if (!rate.allowed)
    throw createError({
      status: 429,
      message: 'Limite de solicitações atingido.',
    })

  const filter: IntegrationAuditFilter = {
    farmId,
    limit: 50,
    ...(appId ? { appId } : {}),
    ...(printerId ? { printerAssignmentId: printerId } : {}),
    ...(before ? { beforeId: before } : {}),
  }
  const entries = deps.listForOwner
    ? await deps.listForOwner(accountId, filter)
    : await new IntegrationAuditService(
        new PostgresIntegrationAudit(deps.pool),
      ).listForOwner(accountId, filter)
  if (!entries)
    throw createError({ status: 404, message: 'Farm não encontrada.' })
  return {
    entries,
    nextCursor:
      entries.length === 50 ? entries[entries.length - 1]!.id : null,
  }
}
