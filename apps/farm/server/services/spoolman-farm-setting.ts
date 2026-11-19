import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { ConfigurationMoonrakerOrigin } from '../../../../packages/farm-protocol/src/configuration-target.ts'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { readPrinterAssignmentBody } from './printer-assignments.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import {
  spoolmanSettingsRuntime,
  type SpoolmanSettingsRuntime,
} from '../utils/spoolman-settings/runtime.ts'

/**
 * The browser may only report the non-secret outcome. `strictObject` makes any
 * credential-shaped field (token, username, password, ...) a 400 so a client bug
 * can never persist a secret on the server.
 */
export const spoolmanSettingBody = z.strictObject({
  agentId: z.string().regex(inventoryUuid),
  origin: ConfigurationMoonrakerOrigin.transform(
    (value) => new URL(value).origin,
  ),
  status: z.enum(['reachable', 'unreachable', 'unauthorized']),
  configured: z.boolean(),
})
const invalid = () =>
  createError({ status: 400, message: 'Solicitação inválida.' })

export function spoolmanBoundary(
  request: Request,
  origin: string,
  operation: 'get' | 'put',
) {
  if (operation === 'get') {
    if (request.method !== 'GET' || new URL(request.url).search) throw invalid()
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
  if (length !== null && (!/^\d{1,6}$/.test(length) || Number(length) > 4096))
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
}

function failure(reason: string): never {
  if (reason === 'invalid-input') throw invalid()
  if (reason === 'storage-unavailable')
    throw createError({
      status: 503,
      message: 'Configuração do Spoolman indisponível. Tente novamente.',
    })
  if (reason === 'unauthorized')
    throw createError({
      status: 401,
      message: 'Entre novamente para continuar.',
    })
  if (reason === 'forbidden')
    throw createError({
      status: 404,
      message: 'Farm ou Connector indisponível para esta conta.',
    })
  throw createError({
    status: 403,
    message: 'Apenas proprietários e administradores configuram o Spoolman.',
  })
}

export async function spoolmanFarmSetting(
  event: Pick<RequestEvent, 'req' | 'res'>,
  operation: 'get' | 'put',
  target: { farmId: string },
  dependencies?: { auth: AuthRuntime; runtime: SpoolmanSettingsRuntime },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  event.res.headers.set('Cache-Control', 'no-store')
  if (!inventoryUuid.test(target.farmId)) throw invalid()
  const auth = dependencies?.auth ?? authRuntime()
  spoolmanBoundary(event.req, auth.origin, operation)
  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `spoolman-setting:${operation}:${sessionRecordId}`,
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
  const runtime = dependencies?.runtime ?? (await spoolmanSettingsRuntime())
  const authority = {
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
    farmId: target.farmId,
  }
  if (operation === 'get') {
    const result = await runtime.settings.list(authority)
    if (!result.ok) return failure(result.reason)
    return { settings: result.settings, canManage: result.canManage }
  }
  const parsed = spoolmanSettingBody.safeParse(
    await readPrinterAssignmentBody(event.req),
  )
  if (!parsed.success) throw invalid()
  const result = await runtime.settings.save({ ...authority, ...parsed.data })
  if (!result.ok) return failure(result.reason)
  return { setting: result.setting }
}
