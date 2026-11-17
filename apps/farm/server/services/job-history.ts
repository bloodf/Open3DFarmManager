import { createError, type RequestEvent } from 'nuxt/server'
import { authResponse, sealedSessionRecordId } from './authenticated-session.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import {
  jobHistoryRuntime,
  type JobHistoryReader,
} from '../utils/job-history-runtime.ts'
import { jobHistoryCursor, type JobHistoryFailure } from './job-history-core.ts'

export function parseJobHistoryQuery(url: string): {
  farmId: string
  printerKey: string | null
  limit: number
  before: string | null
} {
  const query = new URL(url, 'http://localhost').searchParams
  const farmId = query.get('farmId') ?? ''
  const limit = query.get('limit') ?? '20'
  const before = query.get('before')
  const printerKey = query.get('printerKey')
  if (
    [...query.keys()].some(
      (key) => !['farmId', 'limit', 'before', 'printerKey'].includes(key),
    ) ||
    ['farmId', 'limit', 'before', 'printerKey'].some(
      (key) => query.getAll(key).length > 1,
    ) ||
    !inventoryUuid.test(farmId) ||
    !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) ||
    (before !== null && !jobHistoryCursor.test(before)) ||
    (printerKey !== null && !/^.{1,128}$/.test(printerKey))
  )
    throw createError({ status: 400, message: 'Consulta inválida.' })
  return { farmId, printerKey, limit: Number(limit), before }
}
export function jobHistoryFailure(failure: JobHistoryFailure): never {
  switch (failure.reason) {
    case 'invalid-input':
      throw createError({ status: 400, message: 'Consulta inválida.' })
    case 'unauthorized':
      throw createError({
        status: 401,
        message: 'Entre novamente para consultar o histórico.',
      })
    case 'forbidden':
      throw createError({
        status: 404,
        message: 'Farm indisponível para esta conta.',
      })
    case 'storage-unavailable':
      throw createError({
        status: 503,
        message: 'Histórico indisponível. Tente novamente.',
      })
  }
}
export async function jobHistory(
  event: Pick<RequestEvent, 'req' | 'res'>,
  dependencies?: { auth: AuthRuntime; reader: JobHistoryReader },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (event.req.method !== 'GET')
    throw createError({ status: 405, message: 'Método não permitido.' })
  const query = parseJobHistoryQuery(event.req.url)
  const auth = dependencies?.auth ?? authRuntime()
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const reader = dependencies?.reader ?? jobHistoryRuntime()
  const result = await reader.list({
    ...query,
    sessionRecordId,
    policy: { idleTimeoutMs: auth.idleTimeoutMs },
  })
  if (!result.ok) return jobHistoryFailure(result)
  return { jobs: result.jobs, nextBefore: result.nextBefore }
}
