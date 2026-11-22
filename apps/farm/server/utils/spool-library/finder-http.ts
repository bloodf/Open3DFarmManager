import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { createError, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  authResponse,
  mutation,
  sealedSessionRecordId,
} from '../../services/authenticated-session.ts'
import { inventoryUuid } from '../inventory-uuid.ts'
import { authRuntime, type AuthRuntime } from '../auth/runtime.ts'
import {
  scanForAuthority,
  type ScanRefusal,
  type ScanResult,
} from './finder.ts'
import { spoolLibraryRuntime } from './runtime.ts'
import type { SpoolLibraryStorage } from './scope.ts'

type HttpEvent = Pick<RequestEvent, 'req' | 'res'>

export interface SpoolFinderHttpDependencies {
  auth: AuthRuntime
  storage: SpoolLibraryStorage
}

const MAX_BODY_BYTES = 4096
const BODY_TIMEOUT_MS = 5000

const STATUS: Record<ScanRefusal, number> = {
  'invalid-location': 422,
  'unknown-label': 404,
  'wrong-farm': 404,
  archived: 409,
  denied: 403,
  unavailable: 503,
  uncertain: 502,
}

async function readScanBody(
  request: Request,
): Promise<{ label: unknown; location: unknown }> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  const reader = request.body?.getReader()
  if (!reader)
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          createError({ status: 408, message: 'Tempo de envio esgotado.' }),
        )
        void reader.cancel().catch(() => {})
      }, BODY_TIMEOUT_MS)
    })
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_BODY_BYTES)
        throw createError({ status: 413, message: 'Solicitação muito grande.' })
      chunks.push(chunk.value)
    }
    const data = parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: MAX_BODY_BYTES, maxDepth: 2, maxValues: 4 },
    )
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('invalid')
    const body = data as Record<string, unknown>
    return { label: body['label'], location: body['location'] }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw createError({ status: 400, message: 'Solicitação inválida.' })
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

/**
 * `POST /api/spool-finder/<farm>/scan` with `{ label, location }`. A refused
 * scan answers with its reason in `reason` and a pt-BR `message`; the browser
 * never retries a scan whose reason is `uncertain`.
 */
export async function spoolFinderScan(
  event: HttpEvent,
  farmId: string,
  dependencies?: SpoolFinderHttpDependencies,
): Promise<ScanResult> {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (!inventoryUuid.test(farmId))
    throw createError({ status: 400, message: 'Farm inválida.' })
  if (event.req.method.toUpperCase() !== 'POST')
    throw createError({ status: 405, message: 'Método não permitido.' })
  const auth = dependencies?.auth ?? authRuntime()
  mutation(event, auth)
  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const body = await readScanBody(event.req)
  const storage = dependencies?.storage ?? (await spoolLibraryRuntime())
  const result = await scanForAuthority(
    storage,
    {
      kind: 'session',
      sessionRecordId,
      policy: { idleTimeoutMs: auth.idleTimeoutMs },
      farmId,
    },
    body,
  )
  if (!result.ok)
    throw createError({
      status: STATUS[result.reason],
      message: result.message,
      data: { reason: result.reason, message: result.message },
    })
  return result
}
