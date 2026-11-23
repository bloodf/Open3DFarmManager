import { resinArtifactFormats } from '../../../../packages/shared/src/print-file/resin-artifacts.ts'
import { useRuntimeConfig } from 'nuxt/server'
import type { IntegrationPrincipal } from './integration-auth.ts'
import { uuidPattern } from './integration-auth.ts'
import { integrationBase, integrationProblem } from './integration-auth-http.ts'
import type { LibraryProblem } from '../services/integration-library.ts'
import { integrationLibraryRuntime } from './integration-jobs-runtime.ts'

const DEFAULT_MAX = 512 * 1024 * 1024

class TooLarge extends Error {}

export function libraryUploadLimit(config: object) {
  const library = 'library' in config ? config.library : undefined
  const value =
    library && typeof library === 'object' && 'maxUploadBytes' in library
      ? library.maxUploadBytes
      : undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX
}

function problem(code: LibraryProblem, headers?: HeadersInit) {
  return integrationProblem(code, headers)
}

async function readBounded(request: Request, max: number) {
  const reader = request.body?.getReader()
  if (!reader) throw new SyntaxError('empty')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > max) throw new TooLarge()
      chunks.push(chunk.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function decodeBase64(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1)
    return null
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')
  )
    return null
  return new Uint8Array(bytes)
}

function queryOf(url: string) {
  const params = new URL(url).searchParams
  const keys = [...params.keys()]
  return { params, keys }
}

function runtimeService() {
  return integrationLibraryRuntime()
}

export async function listIntegrationLibrary(
  request: Request,
  principal: IntegrationPrincipal,
  headers?: HeadersInit,
) {
  const { params, keys } = queryOf(request.url)
  const farms = params.getAll('farmId')
  const limits = params.getAll('limit')
  const cursors = params.getAll('cursor')
  const farmId = farms[0]?.toLowerCase()
  const limit = limits[0] ?? '50'
  const cursor = cursors[0] ?? null
  if (
    keys.some((key) => !['farmId', 'limit', 'cursor'].includes(key)) ||
    farms.length !== 1 ||
    limits.length > 1 ||
    cursors.length > 1 ||
    !farmId ||
    !uuidPattern.test(farmId) ||
    !/^(?:[1-9]\d?|100)$/.test(limit) ||
    (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
  )
    return integrationProblem('invalid-request', headers)
  try {
    const { service } = await runtimeService()
    const result = await service.list(principal, farmId, cursor, Number(limit))
    if (!result.ok) return problem(result.problem, headers)
    return { ...result.value, resinArtifactFormats }
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function readIntegrationLibraryItem(
  principal: IntegrationPrincipal,
  itemId: string,
  headers?: HeadersInit,
) {
  try {
    const { service } = await runtimeService()
    const result = await service.get(principal, itemId.toLowerCase())
    if (!result.ok) return problem(result.problem, headers)
    return result.value
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function readIntegrationLibrarySettings(
  request: Request,
  principal: IntegrationPrincipal,
  headers?: HeadersInit,
) {
  const { params, keys } = queryOf(request.url)
  const farms = params.getAll('farmId')
  const farmId = farms[0]?.toLowerCase()
  if (
    keys.some((key) => key !== 'farmId') ||
    farms.length !== 1 ||
    !farmId ||
    !uuidPattern.test(farmId)
  )
    return integrationProblem('invalid-request', headers)
  try {
    const { service } = await runtimeService()
    const result = await service.settings(principal, farmId)
    if (!result.ok) return problem(result.problem, headers)
    return result.value
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function patchIntegrationLibrarySettings(
  request: Request,
  principal: IntegrationPrincipal,
  headers?: HeadersInit,
) {
  if (new URL(request.url).search)
    return integrationProblem('invalid-request', headers)
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    return integrationProblem('unsupported-media-type', headers)
  let body: unknown
  try {
    const raw = await readBounded(request, 16 * 1024)
    body = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return integrationProblem(
      error instanceof TooLarge ? 'payload-too-large' : 'invalid-request',
      headers,
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return integrationProblem('invalid-request', headers)
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !['farmId', 'storageMode'].includes(key),
    ) ||
    typeof record.farmId !== 'string'
  )
    return integrationProblem('invalid-request', headers)
  try {
    const { service } = await runtimeService()
    const result = await service.setSettings(
      principal,
      record.farmId.toLowerCase(),
      record.storageMode,
    )
    if (!result.ok) return problem(result.problem, headers)
    return result.value
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}

export async function uploadIntegrationLibrary(
  request: Request,
  principal: IntegrationPrincipal,
  headers?: HeadersInit,
) {
  if (new URL(request.url).search)
    return integrationProblem('invalid-request', headers)
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    return integrationProblem('unsupported-media-type', headers)
  const maxBytes = libraryUploadLimit(useRuntimeConfig())
  let body: unknown
  try {
    const raw = await readBounded(
      request,
      Math.min(32 * 1024 * 1024, maxBytes * 2 + 65_536),
    )
    body = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return integrationProblem(
      error instanceof TooLarge ? 'payload-too-large' : 'invalid-request',
      headers,
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return integrationProblem('invalid-request', headers)
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) =>
        !['farmId', 'name', 'contentBase64', 'resinProfile'].includes(key),
    ) ||
    typeof record.farmId !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.contentBase64 !== 'string' ||
    ('resinProfile' in record && typeof record.resinProfile !== 'string')
  )
    return integrationProblem('invalid-request', headers)
  const bytes = decodeBase64(record.contentBase64)
  if (!bytes) return integrationProblem('invalid-request', headers)
  try {
    const { service } = await runtimeService()
    const result = await service.upload(
      principal,
      {
        farmId: record.farmId.toLowerCase(),
        name: record.name,
        bytes,
        ...(typeof record.resinProfile === 'string'
          ? { resinProfile: record.resinProfile }
          : {}),
      },
      maxBytes,
    )
    if (!result.ok)
      return integrationProblem(
        result.problem,
        headers,
        result.reason
          ? [
              {
                pointer:
                  result.reason === 'profile-mismatch'
                    ? '/resinProfile'
                    : '/name',
                detail: result.reason,
              },
            ]
          : undefined,
      )
    const responseHeaders = new Headers(headers)
    responseHeaders.set('cache-control', 'no-store')
    responseHeaders.set(
      'location',
      `${integrationBase}/library/${result.value.item.id}`,
    )
    return Response.json(result.value, {
      status: 201,
      headers: responseHeaders,
    })
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}
