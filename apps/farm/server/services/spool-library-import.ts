import { createError, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  authResponse,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import {
  spoolImportRuntime,
  type SpoolImportRuntime,
} from '../utils/spool-library-import/runtime.ts'
import {
  MAX_IMPORT_BYTES,
  runSpoolLibraryImport,
  spoolLibraryImportBody,
} from '../utils/spool-library-import/pipeline.ts'

const invalid = () =>
  createError({ status: 400, message: 'Solicitação inválida.' })

export function importBoundary(request: Request, origin: string) {
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
  if (
    length !== null &&
    (!/^\d{1,9}$/.test(length) || Number(length) > MAX_IMPORT_BYTES)
  )
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
}

async function readBody(request: Request): Promise<unknown> {
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
      }, 30_000)
    })
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_IMPORT_BYTES)
        throw createError({ status: 413, message: 'Solicitação muito grande.' })
      chunks.push(chunk.value)
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    )
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw invalid()
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

const problems = (list: unknown) =>
  createError({
    status: 422,
    message: 'Os dados importados são inválidos.',
    data: { problems: list },
  })

function failure(reason: string, extra?: unknown): never {
  switch (reason) {
    case 'invalid-input':
      throw extra ? problems(extra) : invalid()
    case 'unresolved-reference':
      throw problems(extra)
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para continuar.',
      })
    case 'forbidden':
      throw createError({
        status: 404,
        message: 'Farm indisponível para esta conta.',
      })
    case 'denied':
      throw createError({
        status: 403,
        message:
          'Apenas proprietários e administradores importam a biblioteca.',
      })
    case 'source-not-allowed':
      throw createError({
        status: 403,
        message:
          'Este endereço do Spoolman não está autorizado para importação.',
      })
    case 'source-unauthorized':
      throw createError({
        status: 502,
        message: 'O Spoolman recusou as credenciais.',
      })
    case 'source-too-large':
      throw createError({
        status: 413,
        message: 'A biblioteca de origem é grande demais.',
      })
    case 'source-invalid':
      throw createError({
        status: 502,
        message: 'Resposta inesperada do Spoolman.',
      })
    case 'source-unavailable':
      throw createError({
        status: 502,
        message: 'Não foi possível ler o Spoolman.',
      })
    case 'busy':
      throw createError({
        status: 409,
        message: 'Outra importação está em andamento. Tente novamente.',
      })
    default:
      throw createError({
        status: 503,
        message: 'Importação indisponível. Tente novamente.',
      })
  }
}

/**
 * Owner/admin import of an existing spool library into one farm. Nothing about
 * the source (origin, token, payload) is logged or returned except counts.
 */
export async function spoolLibraryImport(
  event: Pick<RequestEvent, 'req' | 'res'>,
  target: { farmId: string },
  dependencies?: { auth: AuthRuntime; runtime: SpoolImportRuntime },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  event.res.headers.set('Cache-Control', 'no-store')
  if (!inventoryUuid.test(target.farmId)) throw invalid()
  const auth = dependencies?.auth ?? authRuntime()
  importBoundary(event.req, auth.origin)
  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  try {
    if (
      !(await auth.credentials.consumeLimit(
        's',
        `spool-import:${sessionRecordId}`,
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
  const parsed = spoolLibraryImportBody.safeParse(await readBody(event.req))
  if (!parsed.success) throw invalid()
  const runtime = dependencies?.runtime ?? (await spoolImportRuntime())
  const result = await runSpoolLibraryImport(
    {
      sessionRecordId,
      policy: { idleTimeoutMs: auth.idleTimeoutMs },
      farmId: target.farmId,
    },
    parsed.data,
    runtime,
  )
  if (!result.ok) return failure(result.reason, result.problems)
  return { report: result.report }
}
