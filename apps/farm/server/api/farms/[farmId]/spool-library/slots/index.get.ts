import { createError, defineEventHandler, getQuery, getRouterParam } from 'nuxt/server'
import { PostgresSpoolSlots } from '../../../../../storage/postgres-spool-slots.ts'
import { spoolSlotsRuntime } from '../../../../../services/spool-slots.ts'
export default defineEventHandler(async (event) => {
  const farmId = getRouterParam(event, 'farmId')
  const query = getQuery(event)
  if (!farmId || (query.printerId && typeof query.printerId !== 'string') || (query.spoolId && !/^\d+$/.test(String(query.spoolId)))) throw createError({ status: 400, message: 'Solicitação inválida.' })
  const { sql } = await spoolSlotsRuntime()
  return { assignments: await new PostgresSpoolSlots(sql).list({ farmId, printerId: query.printerId as string | undefined, spoolId: query.spoolId ? Number(query.spoolId) : undefined }) }
})
