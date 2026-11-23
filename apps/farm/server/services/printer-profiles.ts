import { createError, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { parseInventoryPage } from './connector-inventory.ts'
import { readPrinterAssignmentBody } from './printer-assignments.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import type { PostgresPrinterProfiles } from '../storage/postgres-printer-profiles.ts'
import { printerAssignmentsRuntime } from '../utils/printer-assignments/runtime.ts'
import {
  machineProfileEditSchema,
  normalizeEdit,
} from '../utils/machine-profile.ts'

export type PrinterProfileOperation = 'read' | 'list' | 'edit'
export interface PrinterProfilesDependencies {
  auth: AuthRuntime
  runtime: {
    profiles: Pick<PostgresPrinterProfiles, 'read' | 'list' | 'edit'>
  }
}

const BODY_LIMITS = { maxBytes: 8192, maxValues: 40, maxDepth: 3 }
const invalid = () =>
  createError({ status: 400, message: 'Solicitação inválida.' })

export function printerProfileBoundary(
  request: Request,
  origin: string,
  operation: PrinterProfileOperation,
) {
  if (operation !== 'edit') {
    if (request.method !== 'GET') throw invalid()
    return
  }
  if (request.method !== 'PUT' || new URL(request.url).search) throw invalid()
  if (!checkMutationOrigin(request.headers.get('origin'), origin).ok)
    throw createError({
      status: 403,
      message: 'Origem da solicitação não permitida.',
    })
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  const length = request.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d{1,6}$/.test(length) || Number(length) > BODY_LIMITS.maxBytes)
  )
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
}

function failure(reason: string): never {
  if (reason === 'invalid-input') throw invalid()
  if (reason === 'storage-unavailable')
    throw createError({
      status: 503,
      message: 'Perfil da máquina indisponível. Tente novamente.',
    })
  if (reason === 'unauthorized')
    throw createError({
      status: 401,
      message: 'Entre novamente para continuar.',
    })
  // A farm or printer the caller cannot see does not exist for the caller.
  if (reason === 'forbidden' || reason === 'not-found')
    throw createError({
      status: 404,
      message: 'Impressora indisponível para esta conta.',
    })
  throw createError({
    status: 403,
    message: 'Somente proprietários e administradores podem editar o perfil.',
  })
}

/** Reads and edits the machine profile of a printer assignment. */
export async function printerProfiles(
  event: Pick<RequestEvent, 'req' | 'res'>,
  operation: PrinterProfileOperation,
  target: { farmId: string; assignmentId?: string },
  dependencies?: PrinterProfilesDependencies,
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (
    !inventoryUuid.test(target.farmId) ||
    (operation !== 'list' &&
      (!target.assignmentId || !inventoryUuid.test(target.assignmentId)))
  )
    throw invalid()
  const auth = dependencies?.auth ?? authRuntime()
  printerProfileBoundary(event.req, auth.origin, operation)
  const page =
    operation === 'list' ? parseInventoryPage(event.req.url) : undefined
  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `printer-profiles:${operation}:${sessionRecordId}`,
      ))
    )
      throw createError({
        status: 429,
        message: 'Muitas tentativas. Aguarde antes de tentar novamente.',
      })
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    return failure('storage-unavailable')
  }
  const { profiles } =
    dependencies?.runtime ?? (await printerAssignmentsRuntime())
  const authority = {
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
    farmId: target.farmId,
  }
  if (operation === 'list' && page) {
    const result = await profiles.list({ ...authority, ...page })
    if (!result.ok) return failure(result.reason)
    return {
      profiles: result.profiles,
      nextAfter: result.nextAfter,
      canManage: result.canManage,
    }
  }
  const assignmentId = target.assignmentId ?? ''
  if (operation === 'read') {
    const result = await profiles.read({ ...authority, assignmentId })
    if (!result.ok) return failure(result.reason)
    return { profile: result.profile, canManage: result.canManage }
  }
  const parsed = machineProfileEditSchema.safeParse(
    await readPrinterAssignmentBody(event.req, BODY_LIMITS),
  )
  if (!parsed.success) throw invalid()
  const result = await profiles.edit({
    ...authority,
    assignmentId,
    profile: normalizeEdit(parsed.data),
  })
  if (!result.ok) return failure(result.reason)
  return { profile: result.profile, canManage: result.canManage }
}
