import postgres from 'postgres'
import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
  useRuntimeConfig,
} from 'nuxt/server'
import { authenticatedSession } from '../../../../services/authenticated-session.ts'
import { authRuntime } from '../../../../utils/auth/runtime.ts'
import { IntegrationAuditService } from '../../../../services/integration-audit.ts'
import { PostgresIntegrationAudit } from '../../../../storage/integration-audit-postgres.ts'

export default defineEventHandler(async (event) => {
  const farmId = getRouterParam(event, 'farmId') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(farmId))
    throw createError({ status: 404, message: 'Farm não encontrada.' })
  const auth = authRuntime()
  const { accountId } = await authenticatedSession(event, auth)
  const query = getQuery(event)
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
  const databaseUrl = useRuntimeConfig().auth.databaseUrl
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 20,
    connection: { statement_timeout: 2000, lock_timeout: 1000 },
  })
  try {
    const service = new IntegrationAuditService(
      new PostgresIntegrationAudit(sql),
    )
    const entries = await service.listForOwner(accountId, {
      farmId,
      appId,
      printerAssignmentId: printerId,
      beforeId: before,
      limit: 50,
    })
    if (!entries)
      throw createError({ status: 404, message: 'Farm não encontrada.' })
    return {
      entries,
      nextCursor:
        entries.length === 50 ? entries[entries.length - 1]!.id : null,
    }
  } finally {
    await sql.end({ timeout: 3 })
  }
})
