import { filamentModule } from './legacy-api/filament.ts'
import type {
  LegacyApiModule,
  LegacyApiResponse,
  LegacyBody,
} from './legacy-api/types.ts'
import { vendorModule } from './legacy-api/vendor.ts'
import { splitLegacyPath } from './legacy-path.ts'
import type {
  Result,
  SpoolLibraryFailureReason,
  SpoolLibraryRepository,
  SpoolLibraryStorage,
} from './scope.ts'

export type {
  LegacyApiModule,
  LegacyApiRequest,
  LegacyApiResponse,
  LegacyBody,
} from './legacy-api/types.ts'

const STATUS: Record<SpoolLibraryFailureReason, 400 | 401 | 403 | 404 | 503> = {
  'invalid-input': 400,
  unauthorized: 401,
  forbidden: 403,
  denied: 403,
  'not-found': 404,
  conflict: 400,
  limit: 400,
  'storage-unavailable': 503,
}

/** Pinned OpenAPI `Message`: one required string, no extra fields. */
const MESSAGE = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
} as const

/**
 * Single-function dispatch (the #541 contract). Kept for callers that serve
 * one path; new endpoints should be a `LegacyApiModule`.
 */
export type LegacyDispatch = (
  repository: SpoolLibraryRepository,
  method: string,
  apiPath: string,
) => Promise<Result<object>>

/** `GET /api/v1/health` — pinned v0.27.1 HealthCheck example, nothing else. */
export const healthModule: LegacyApiModule = {
  name: 'health',
  async handle(_repository, request) {
    if (request.method === 'GET' && request.apiPath === '/api/v1/health')
      return { ok: true, value: { status: 200, body: { status: 'healthy' } } }
    return undefined
  },
}

/**
 * Registered Spoolman endpoint modules, tried in order. Spool, field, setting,
 * tag and other auxiliary modules are appended here as they are implemented.
 */
export const LEGACY_API_MODULES: readonly LegacyApiModule[] = [
  healthModule,
  vendorModule,
  filamentModule,
]

export interface LegacyRequestContext {
  method: string
  pathname: string
  query?: URLSearchParams
  body?: LegacyBody
}

const fromDispatch = (dispatch: LegacyDispatch): LegacyApiModule => ({
  name: 'dispatch',
  async handle(repository, request) {
    const result = await dispatch(repository, request.method, request.apiPath)
    return result.ok
      ? { ok: true, value: { status: 200, body: result.value } }
      : result
  },
})

/**
 * Authenticate `/spoolman/<token>/...` and offer the request to each module
 * inside that farm's single transaction. A module failure rolls it back; an
 * unclaimed path is 404. No farm id ever comes from the request.
 */
export async function handleLegacyRequest(
  storage: SpoolLibraryStorage,
  context: LegacyRequestContext,
  dispatch: LegacyDispatch | readonly LegacyApiModule[] = LEGACY_API_MODULES,
): Promise<LegacyApiResponse> {
  const path = splitLegacyPath(context.pathname)
  if (!path.ok) return legacyFailure('unauthorized')
  const modules =
    typeof dispatch === 'function' ? [fromDispatch(dispatch)] : dispatch
  const request = {
    method: context.method.toUpperCase(),
    apiPath: path.apiPath,
    query: context.query ?? new URLSearchParams(),
    body: context.body ?? ({ kind: 'none' } as const),
  }
  const result = await storage.withScope(
    { kind: 'legacy-credential', token: path.token },
    async (repository): Promise<Result<LegacyApiResponse>> => {
      for (const module of modules) {
        const handled = await module.handle(repository, request)
        if (handled !== undefined) return handled
      }
      return { ok: false, reason: 'not-found' }
    },
  )
  return result.ok ? result.value : legacyFailure(result.reason)
}

export function legacyFailure(
  reason: SpoolLibraryFailureReason,
): LegacyApiResponse {
  const status = STATUS[reason]
  return { status, body: { message: MESSAGE[status] } }
}
