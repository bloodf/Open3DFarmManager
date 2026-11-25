import { createError, type RequestEvent } from 'nuxt/server'
import {
  authenticatedSession,
  authResponse,
  mutation,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { authRuntime, type AuthRuntime } from '../utils/auth/runtime.ts'
import { inventoryUuid } from '../storage/postgres-connector-inventory.ts'
import { spoolLibraryRuntime } from '../utils/spool-library/runtime.ts'
import { spoolFinderScan } from '../utils/spool-library/finder-http.ts'
import type {
  Result,
  SpoolLibraryAccess,
  SpoolLibraryFailureReason,
  SpoolLibraryStorage,
} from '../utils/spool-library/scope.ts'
import { classifyLegacyBody } from '../utils/spool-library/legacy-api/body.ts'
import { filamentModule } from '../utils/spool-library/legacy-api/filament.ts'
import {
  findSpoolsByIds,
  spoolModule,
} from '../utils/spool-library/legacy-api/spool.ts'
import type {
  LegacyApiModule,
  LegacyApiResponse,
  LegacyBody,
} from '../utils/spool-library/legacy-api/types.ts'
import { vendorModule } from '../utils/spool-library/legacy-api/vendor.ts'

export type SpoolLibraryResourceKind = 'spools' | 'filaments' | 'vendors'

export interface SpoolLibraryTarget {
  farmId: string
  resource: SpoolLibraryResourceKind
  id?: string
  action?: 'use' | 'measure'
}

export interface SpoolLibraryHttpDependencies {
  auth: AuthRuntime
  storage: SpoolLibraryStorage
}

type HttpEvent = Pick<RequestEvent, 'req' | 'res'>

const MAX_BODY_BYTES = 1024 * 1024
const BODY_TIMEOUT_MS = 15_000
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT'])

const MODULE_FOR: Record<
  SpoolLibraryResourceKind,
  { module: LegacyApiModule; singular: 'spool' | 'filament' | 'vendor' }
> = {
  spools: { module: spoolModule, singular: 'spool' },
  filaments: { module: filamentModule, singular: 'filament' },
  vendors: { module: vendorModule, singular: 'vendor' },
}

const invalid = (message = 'Solicitação inválida.') =>
  createError({ status: 400, message })

function normalizeSearch(value: string): string {
  return value
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

function collectSearchText(
  resource: SpoolLibraryResourceKind,
  item: Record<string, unknown>,
): string {
  const parts: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) parts.push(value)
    else if (typeof value === 'number' && Number.isFinite(value))
      parts.push(String(value))
  }
  push(item.id)
  if (item.id !== undefined) parts.push(`#${String(item.id)}`)
  if (resource === 'vendors') {
    push(item.name)
    push(item.comment)
    push(item.external_id)
  } else if (resource === 'filaments') {
    push(item.name)
    push(item.material)
    push(item.article_number)
    push(item.external_id)
    push(item.comment)
    push(item.color_hex)
    const vendor = item.vendor as Record<string, unknown> | undefined
    if (vendor) push(vendor.name)
  } else {
    push(item.location)
    push(item.lot_nr)
    push(item.comment)
    const filament = item.filament as Record<string, unknown> | undefined
    if (filament) {
      push(filament.name)
      push(filament.material)
      push(filament.article_number)
      push(filament.color_hex)
      const vendor = filament.vendor as Record<string, unknown> | undefined
      if (vendor) push(vendor.name)
    }
  }
  return normalizeSearch(parts.join(' '))
}

async function readJsonBody(request: Request): Promise<LegacyBody> {
  const contentType = request.headers.get('content-type')
  if (
    contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
    request.headers.has('content-encoding')
  ) {
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  }
  const length = request.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d{1,9}$/.test(length) || Number(length) > MAX_BODY_BYTES)
  ) {
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
  }
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
      }, BODY_TIMEOUT_MS)
    })
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        throw createError({ status: 413, message: 'Solicitação muito grande.' })
      }
      chunks.push(chunk.value)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    )
    const body = classifyLegacyBody(text, contentType)
    if (body.kind !== 'json') throw invalid('Dados em JSON inválidos.')
    return body
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw invalid('Dados em JSON inválidos.')
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

function throwScopeFailure(reason: SpoolLibraryFailureReason): never {
  switch (reason) {
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
          'Apenas operadores, administradores e proprietários podem alterar a biblioteca.',
      })
    case 'not-found':
      throw createError({
        status: 404,
        message: 'Registro não encontrado.',
      })
    case 'conflict':
      throw createError({
        status: 409,
        message:
          'Não foi possível concluir a alteração porque outro registro depende deste item.',
      })
    case 'invalid-input':
    case 'limit':
      throw invalid()
    default:
      throw createError({
        status: 503,
        message: 'Biblioteca de bobinas indisponível. Tente novamente.',
      })
  }
}

function parsePageInt(
  raw: string | null,
  fallback: number | null,
): number | null {
  if (raw === null) return fallback
  if (!/^-?\d+$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : null
}

function throwLegacyError(
  resource: SpoolLibraryResourceKind,
  method: string,
  response: LegacyApiResponse,
): never {
  if (response.status === 404) {
    const label =
      resource === 'spools'
        ? 'Bobina não encontrada.'
        : resource === 'filaments'
          ? 'Filamento não encontrado.'
          : 'Fornecedor não encontrado.'
    throw createError({ status: 404, message: label })
  }
  if (
    response.status === 403 &&
    resource === 'filaments' &&
    method === 'DELETE'
  ) {
    throw createError({
      status: 409,
      message:
        'Não é possível excluir este filamento porque existem bobinas vinculadas a ele.',
    })
  }
  if (response.status === 422) {
    const detail =
      response.body &&
      typeof response.body === 'object' &&
      'detail' in response.body &&
      Array.isArray((response.body as { detail?: unknown }).detail)
        ? (response.body as { detail: unknown[] }).detail
        : undefined
    throw createError({
      status: 422,
      message: 'Revise os campos informados e tente novamente.',
      ...(detail ? { data: { issues: detail } } : {}),
    })
  }
  if (response.status === 400) {
    const raw =
      response.body &&
      typeof response.body === 'object' &&
      'message' in response.body &&
      typeof (response.body as { message?: unknown }).message === 'string'
        ? (response.body as { message: string }).message
        : ''
    if (raw.includes('Initial weight is not set')) {
      throw createError({
        status: 400,
        message:
          'Defina o peso inicial da bobina ou do filamento antes de registrar a pesagem.',
      })
    }
    if (raw.includes('Only specify either remaining_weight or used_weight')) {
      throw createError({
        status: 400,
        message: 'Informe apenas o peso restante ou o peso usado, não ambos.',
      })
    }
    if (raw.includes('Only specify either use_weight or use_length')) {
      throw createError({
        status: 400,
        message: 'Informe apenas o peso ou o comprimento consumido, não ambos.',
      })
    }
    if (raw.includes('Either use_weight or use_length must be specified')) {
      throw createError({
        status: 400,
        message: 'Informe o peso ou o comprimento consumido.',
      })
    }
    throw createError({
      status: 400,
      message: 'Não foi possível validar os dados enviados.',
    })
  }
  if (response.status === 405) {
    throw createError({ status: 405, message: 'Método não permitido.' })
  }
  throw createError({
    status: response.status >= 500 ? 503 : response.status,
    message: 'Não foi possível concluir a operação na biblioteca de bobinas.',
  })
}

export async function spoolLibraryResource(
  event: HttpEvent,
  target: SpoolLibraryTarget | { farmId: string; resource: 'finder' },
  dependencies?: SpoolLibraryHttpDependencies,
) {
  if (target.resource === 'finder')
    return spoolFinderScan(event, target.farmId, dependencies)

  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (!inventoryUuid.test(target.farmId)) throw invalid('Farm inválida.')

  const method = event.req.method.toUpperCase()
  const auth = dependencies?.auth ?? authRuntime()
  if (MUTATING_METHODS.has(method)) mutation(event, auth)

  await authenticatedSession(event, auth)
  const sessionRecordId = await sealedSessionRecordId(event, auth)
  const body: LegacyBody = BODY_METHODS.has(method)
    ? await readJsonBody(event.req)
    : { kind: 'none' }

  const url = new URL(event.req.url)
  const incomingQuery = new URLSearchParams(url.search)
  const searchTerm = incomingQuery.get('q')?.trim() ?? ''
  const isList = method === 'GET' && target.id === undefined

  let requestedLimit: number | null = null
  let requestedOffset = 0
  if (isList && searchTerm) {
    const rawLimit = incomingQuery.get('limit')
    const rawOffset = incomingQuery.get('offset')
    requestedLimit = parsePageInt(rawLimit, null)
    const parsedOffset = parsePageInt(rawOffset, 0)
    if (
      (rawLimit !== null && requestedLimit === null) ||
      (rawOffset !== null && parsedOffset === null)
    ) {
      throw createError({
        status: 422,
        message: 'Parâmetros de paginação inválidos.',
      })
    }
    requestedOffset = parsedOffset ?? 0
    incomingQuery.delete('q')
    incomingQuery.delete('limit')
    incomingQuery.delete('offset')
  } else {
    incomingQuery.delete('q')
  }

  const { module, singular } = MODULE_FOR[target.resource]
  let apiPath = `/api/v1/${singular}`
  if (target.id !== undefined) apiPath += `/${target.id}`
  if (target.action) apiPath += `/${target.action}`

  const spoolIds =
    isList && target.resource === 'spools' ? incomingQuery.get('ids') : null

  const storage = dependencies?.storage ?? (await spoolLibraryRuntime())
  const scoped = await storage.withScope<{
    response: LegacyApiResponse
    access: SpoolLibraryAccess
  }>(
    {
      kind: 'session',
      sessionRecordId,
      policy: { idleTimeoutMs: auth.idleTimeoutMs },
      farmId: target.farmId,
    },
    async (
      repository,
    ): Promise<
      Result<{ response: LegacyApiResponse; access: SpoolLibraryAccess }>
    > => {
      const handled =
        spoolIds === null
          ? await module.handle(repository, {
              method,
              apiPath,
              query: incomingQuery,
              body,
            })
          : await findSpoolsByIds(repository, spoolIds)
      if (!handled) return { ok: false, reason: 'not-found' }
      if (!handled.ok) return handled
      return {
        ok: true,
        value: { response: handled.value, access: repository.access },
      }
    },
  )

  if (!scoped.ok) throwScopeFailure(scoped.reason)
  const { response, access } = scoped.value
  if (response.status >= 400)
    throwLegacyError(target.resource, method, response)

  const permissions = {
    access,
    canWrite: access === 'write' || access === 'manage',
    canImport: access === 'manage',
  }

  if (isList) {
    const rawItems = Array.isArray(response.body)
      ? (response.body as Record<string, unknown>[])
      : []
    if (searchTerm) {
      const needle = normalizeSearch(searchTerm)
      const filtered = rawItems.filter((item) =>
        collectSearchText(target.resource, item).includes(needle),
      )
      const start = Math.max(0, requestedOffset)
      const page =
        requestedLimit === null
          ? filtered.slice(start)
          : requestedLimit <= 0
            ? []
            : filtered.slice(start, start + requestedLimit)
      return { items: page, total: filtered.length, ...permissions }
    }
    const headerTotal = Number(response.headers?.['x-total-count'])
    const total = Number.isFinite(headerTotal) ? headerTotal : rawItems.length
    return { items: rawItems, total, ...permissions }
  }

  if (method === 'GET') {
    return { item: response.body, ...permissions }
  }

  if (method === 'POST') {
    event.res.status = 201
    return { item: response.body }
  }

  if (method === 'DELETE') {
    return { deleted: true }
  }

  return { item: response.body }
}
