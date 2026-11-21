import { splitLegacyPath } from './legacy-path.ts'
import type {
  Result,
  SpoolLibraryFailureReason,
  SpoolLibraryRepository,
  SpoolLibraryStorage,
} from './scope.ts'

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

export type LegacyDispatch = (
  repository: SpoolLibraryRepository,
  method: string,
  apiPath: string,
) => Promise<Result<object>>

/**
 * Authenticate `/spoolman/<token>/...` and run `dispatch` inside that farm.
 * Additional Spoolman paths pass their own dispatch; the default is health.
 */
export async function handleLegacyRequest(
  storage: SpoolLibraryStorage,
  context: { method: string; pathname: string },
  dispatch: LegacyDispatch = defaultDispatch,
): Promise<{ status: number; body: object }> {
  const path = splitLegacyPath(context.pathname)
  if (!path.ok) return legacyFailure('unauthorized')
  const result = await storage.withScope(
    { kind: 'legacy-credential', token: path.token },
    (repository) => dispatch(repository, context.method, path.apiPath),
  )
  if (result.ok) return { status: 200, body: result.value }
  return legacyFailure(result.reason)
}

export function legacyFailure(reason: SpoolLibraryFailureReason) {
  const status = STATUS[reason]
  return { status, body: { message: MESSAGE[status] } }
}

/** `GET /api/v1/health` — pinned v0.27.1 HealthCheck example, nothing else. */
async function defaultDispatch(
  _repository: SpoolLibraryRepository,
  method: string,
  apiPath: string,
): Promise<Result<object>> {
  if (method === 'GET' && apiPath === '/api/v1/health')
    return { ok: true, value: { status: 'healthy' } }
  return { ok: false, reason: 'not-found' }
}
