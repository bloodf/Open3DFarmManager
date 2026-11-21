import { createError, defineEventHandler, getRouterParam, readBody } from 'nuxt/server'
import { z } from 'zod'
import { PostgresSpoolSlots } from '../../../../../storage/postgres-spool-slots.ts'
import { spoolSlotsRuntime } from '../../../../../services/spool-slots.ts'
const bodySchema = z.strictObject({ spoolId: z.number().int().positive().safe(), printerId: z.string().uuid(), slotKind: z.enum(['printer','ams','toolhead']), slotIndex: z.number().int().min(0).max(1024) })
export default defineEventHandler(async (event) => {
  const farmId = getRouterParam(event, 'farmId')
  const body = bodySchema.safeParse(await readBody(event))
  if (!farmId || !body.success) throw createError({ status: 400, message: 'Solicitação inválida.' })
  const { sql } = await spoolSlotsRuntime()
  const assignment = await new PostgresSpoolSlots(sql).assign({ farmId, ...body.data })
  if (!assignment) throw createError({ status: 400, message: 'Solicitação inválida.' })
  return { assignment }
})
