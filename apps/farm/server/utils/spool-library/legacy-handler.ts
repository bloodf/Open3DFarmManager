import { createConfiguredExternalModule } from './legacy-api/external-config.ts'
import { exportModule } from './legacy-api/export.ts'
import { fieldModule } from './legacy-api/field.ts'
import { filamentModule } from './legacy-api/filament.ts'
import { groupModule } from './legacy-api/group.ts'
import { infoModule } from './legacy-api/info.ts'
import { listsModule } from './legacy-api/lists.ts'
import { locationModule } from './legacy-api/location.ts'
import { searchModule } from './legacy-api/search.ts'
import { settingModule } from './legacy-api/setting.ts'
import { spoolModule } from './legacy-api/spool.ts'
import {
  MUTATING,
  type LegacyApiModule,
  type LegacyApiResponse,
  type LegacyBody,
} from './legacy-api/types.ts'
import { vendorModule } from './legacy-api/vendor.ts'
import {
  spoolFeedBus,
  type SpoolFeedBus,
  type SpoolFeedEvent,
} from './events.ts'
import { splitLegacyPath } from './legacy-path.ts'
import { observeRepository } from './observe.ts'
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
 * Registered Spoolman endpoint modules, tried in order. Tag modules are
 * appended here once the tag storage exists.
 */
export const LEGACY_API_MODULES: readonly LegacyApiModule[] = [
  healthModule,
  infoModule,
  settingModule,
  fieldModule,
  locationModule,
  listsModule,
  exportModule,
  searchModule,
  groupModule,
  vendorModule,
  filamentModule,
  spoolModule,
  createConfiguredExternalModule(),
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
  feed: SpoolFeedBus = spoolFeedBus,
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
  // Changes are recorded while the farm's transaction runs and published only
  // once it has committed, to that farm's websocket feeds alone.
  const events: SpoolFeedEvent[] = []
  let farmId = ''
  const result = await storage.withScope(
    { kind: 'legacy-credential', token: path.token },
    async (scoped): Promise<Result<LegacyApiResponse>> => {
      farmId = scoped.farmId
      const mutating = MUTATING.has(request.method)
      const repository =
        mutating && feed.hasSubscribers(farmId)
          ? observeRepository(scoped, events)
          : scoped
      for (const module of modules) {
        const handled = await module.handle(repository, request)
        if (handled !== undefined) return handled
      }
      return { ok: false, reason: 'not-found' }
    },
  )
  if (!result.ok) return legacyFailure(result.reason)
  if (events.length > 0 && result.value.status < 400)
    feed.publish(farmId, events)
  return result.value
}

export function legacyFailure(
  reason: SpoolLibraryFailureReason,
): LegacyApiResponse {
  const status = STATUS[reason]
  return { status, body: { message: MESSAGE[status] } }
}
