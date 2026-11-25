import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import {
  authResponse,
  mutation,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { body } from './spool-usage.ts'
import { spoolSlotsRuntime } from './spool-slots.ts'
import { PostgresSpoolSlots } from '../storage/postgres-spool-slots.ts'
import {
  PostgresSpoolSlotAccess,
  SlotAccessError,
  type SlotAccess,
} from '../storage/postgres-spool-slot-access.ts'

type SlotEvent = Pick<RequestEvent, 'req' | 'res'>
export type SlotOperation = 'list' | 'assign' | 'unassign'
export interface SlotsDeps {
  auth: AuthRuntime
  access: SlotAccess
  slots: Pick<PostgresSpoolSlots, 'list' | 'assign' | 'unassign'>
}

const slotShape = {
  printerId: z.string().uuid(),
  slotKind: z.enum(['printer', 'ams', 'toolhead']),
  slotIndex: z.number().int().min(0).max(1024),
}
const assignSchema = z.strictObject({
  spoolId: z.number().int().positive().safe(),
  ...slotShape,
})
const unassignSchema = z.strictObject(slotShape)

const invalid = () =>
  createError({ status: 400, message: 'Solicitação inválida.' })
const unavailable = () =>
  createError({ status: 503, message: 'Recurso indisponível.' })

/** Query string to list filters; duplicated keys and malformed values are refused. */
function listQuery(url: string) {
  const params = new URL(url, 'http://localhost').searchParams
  const one = (key: string): string | undefined => {
    const all = params.getAll(key)
    if (all.length > 1) throw invalid()
    return all[0] || undefined
  }
  const printerId = one('printerId')
  const spoolId = one('spoolId')
  if (
    (printerId !== undefined &&
      !z.string().uuid().safeParse(printerId).success) ||
    (spoolId !== undefined && !/^\d{1,16}$/.test(spoolId))
  )
    throw invalid()
  return {
    ...(printerId === undefined ? {} : { printerId }),
    ...(spoolId === undefined ? {} : { spoolId: Number(spoolId) }),
  }
}

async function productionDeps(): Promise<SlotsDeps> {
  const auth = authRuntime()
  const { sql } = await spoolSlotsRuntime()
  return {
    auth,
    access: new PostgresSpoolSlotAccess(sql),
    slots: new PostgresSpoolSlots(sql),
  }
}

/**
 * Authenticated, farm-scoped slot operations. The farm in the path is only
 * trusted after the session's account is shown to be an active member; writes
 * need operator or higher and the exact Origin.
 */
export async function spoolSlotsFeature(
  event: SlotEvent,
  farmId: string | undefined,
  op: SlotOperation,
  deps?: SlotsDeps,
) {
  const auth = deps?.auth ?? authRuntime()
  authResponse(event)
  const write = op !== 'list'
  if (write) mutation(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  if (!farmId) throw invalid()
  try {
    const { access, slots } = deps ?? (await productionDeps())
    const role = await access.authorize({
      farmId,
      sessionRecordId,
      policy: { idleTimeoutMs: auth.idleTimeoutMs },
    })
    if (write && role === 'viewer') throw new SlotAccessError(403)
    if (op === 'list')
      return {
        assignments: await slots.list({ farmId, ...listQuery(event.req.url) }),
      }
    const raw = await body(event.req)
    if (op === 'assign') {
      const parsed = assignSchema.safeParse(raw)
      if (!parsed.success) throw invalid()
      const assignment = await slots.assign({ farmId, ...parsed.data })
      if (!assignment) throw invalid()
      return { assignment }
    }
    const parsed = unassignSchema.safeParse(raw)
    if (!parsed.success) throw invalid()
    return { unassigned: await slots.unassign({ farmId, ...parsed.data }) }
  } catch (e) {
    if (e instanceof SlotAccessError)
      throw createError({
        status: e.status,
        message: 'Solicitação indisponível.',
      })
    if (e && typeof e === 'object' && 'status' in e) throw e
    // A spool or printer of another farm fails the composite (farm_id, id) key.
    if (e && typeof e === 'object' && 'code' in e && e.code === '23503')
      throw createError({ status: 404, message: 'Solicitação indisponível.' })
    throw unavailable()
  }
}
