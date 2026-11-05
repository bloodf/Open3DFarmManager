import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { parseInventoryPage } from './connector-inventory.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import { validPrinterOwnershipKey } from '../storage/postgres-printer-ownership.ts'
import {
  printerAssignmentsRuntime,
  type PrinterAssignmentsRuntime,
} from '../utils/printer-assignments/runtime.ts'
const key = z.string().refine(validPrinterOwnershipKey)
const registerBody = z.strictObject({
  agentId: z.string().regex(inventoryUuid),
  printerKey: key,
  confirmedLocalConfiguration: z.literal(true),
})
const revokeBody = z.strictObject({
  agentId: z.string().regex(inventoryUuid),
  printerKey: key,
})
const invalid = () =>
  createError({ status: 400, message: 'Solicitação inválida.' })
export function printerAssignmentBoundary(
  request: Request,
  origin: string,
  operation: 'list' | 'register' | 'revoke',
) {
  if (operation === 'list') {
    if (request.method !== 'GET') throw invalid()
    return
  }
  if (request.method !== 'POST' || new URL(request.url).search) throw invalid()
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
export async function readPrinterAssignmentBody(
  request: Request,
): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw invalid()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          createError({ status: 408, message: 'Tempo de envio esgotado.' }),
        )
        void reader.cancel().catch(() => {})
      }, 5000)
    })
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 4096)
        throw createError({ status: 413, message: 'Solicitação muito grande.' })
      chunks.push(chunk.value)
    }
    return parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: 4096, maxDepth: 2, maxValues: 8, maxStringChars: 1024 },
    )
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw invalid()
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function failure(reason: string): never {
  if (reason === 'invalid-input') throw invalid()
  if (reason === 'storage-unavailable')
    throw createError({
      status: 503,
      message: 'Cadastro de impressoras indisponível. Tente novamente.',
    })
  if (reason === 'unauthorized')
    throw createError({
      status: 401,
      message: 'Entre novamente para continuar.',
    })
  if (reason === 'conflict')
    throw createError({
      status: 409,
      message:
        'Esta chave já tem uma atribuição ativa. Atualize a lista antes de continuar.',
    })
  throw createError({
    status: 403,
    message: 'Não foi possível autorizar esta solicitação.',
  })
}
export async function printerAssignments(
  event: Pick<RequestEvent, 'req' | 'res'>,
  operation: 'list' | 'register' | 'revoke',
  target: { farmId: string; assignmentId?: string },
  dependencies?: { auth: AuthRuntime; runtime: PrinterAssignmentsRuntime },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (
    !inventoryUuid.test(target.farmId) ||
    (operation === 'revoke' &&
      (!target.assignmentId || !inventoryUuid.test(target.assignmentId)))
  )
    throw invalid()
  const auth = dependencies?.auth ?? authRuntime()
  printerAssignmentBoundary(event.req, auth.origin, operation)
  const page =
    operation === 'list' ? parseInventoryPage(event.req.url) : undefined
  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `printer-assignments:${operation}:${sessionRecordId}`,
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
  const runtime = dependencies?.runtime ?? (await printerAssignmentsRuntime())
  const authority = {
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
    farmId: target.farmId,
  }
  if (operation === 'list' && page) {
    const result = await runtime.inventory.list({ ...authority, ...page })
    if (!result.ok) return failure(result.reason)
    return {
      printers: result.printers,
      nextAfter: result.nextAfter,
      canManage: result.canManage,
    }
  }
  const body = await readPrinterAssignmentBody(event.req)
  if (operation === 'register') {
    const parsed = registerBody.safeParse(body)
    if (!parsed.success) throw invalid()
    const result = await runtime.ownership.register({
      ...authority,
      agentId: parsed.data.agentId,
      printerKey: parsed.data.printerKey,
    })
    if (!result.ok) return failure(result.reason)
    return { assignmentId: result.assignmentId, status: result.status }
  }
  const parsed = revokeBody.safeParse(body)
  if (!parsed.success || !target.assignmentId) throw invalid()
  const result = await runtime.ownership.revoke({
    ...authority,
    ...parsed.data,
    expectedAssignmentId: target.assignmentId,
  })
  if (!result.ok) return failure(result.reason)
  return { assignmentId: result.assignmentId, status: result.status }
}
