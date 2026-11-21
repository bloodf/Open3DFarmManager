import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from 'nuxt/server'
import { z } from 'zod'
import { PostgresSpoolSlots } from '../../../../../storage/postgres-spool-slots.ts'
import { spoolSlotsRuntime } from '../../../../../services/spool-slots.ts'
const bodySchema = z.strictObject({
  printerId: z.string().uuid(),
  slotKind: z.enum(['printer', 'ams', 'toolhead']),
  slotIndex: z.number().int().min(0).max(1024),
})
export default defineEventHandler(async (event) => {
  const farmId = getRouterParam(event, 'farmId')
  const body = bodySchema.safeParse(await readBody(event))
  if (!farmId || !body.success)
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  const { sql } = await spoolSlotsRuntime()
  return {
    unassigned: await new PostgresSpoolSlots(sql).unassign({
      farmId,
      ...body.data,
    }),
  }
})
