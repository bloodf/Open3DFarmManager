/**
 * Handler contract for the Spoolman-compatible legacy API.
 *
 * The shared dispatcher authenticates `/spoolman/<token>/...`, opens one
 * farm-bound transaction and offers the request to each registered module in
 * order. A module claims a request by returning a response (or a repository
 * failure, which rolls the transaction back); it returns `undefined` for paths
 * it does not own. Spool, field, setting and other endpoints are added later
 * as further modules without touching the dispatcher.
 */
import type {
  Result,
  SpoolLibraryFailureReason,
  SpoolLibraryRepository,
} from '../scope.ts'

/** The request body as the route received it, before any validation. */
export type LegacyBody = (
  | {
      kind: 'none'
      /** The body was the JSON text `null` (FastAPI sees `None`). */
      jsonNull?: true
    }
  /** A body that is not JSON (FastAPI then validates the raw bytes). */
  | { kind: 'raw'; text: string }
  | { kind: 'json'; value: unknown }
  /** `error` is Python's `JSONDecodeError.msg` for the received text. */
  | { kind: 'invalid-json'; error?: string }
) & {
  /** Media type of the request (lower-case, parameters removed), if sent. */
  contentType?: string
}

export interface LegacyApiRequest {
  method: string
  /** Spoolman path, e.g. `/api/v1/vendor/3`. Never contains the credential. */
  apiPath: string
  query: URLSearchParams
  body: LegacyBody
}

export interface LegacyApiResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type LegacyModuleResult = Result<LegacyApiResponse> | undefined

export interface LegacyApiModule {
  /** Stable module name for diagnostics. */
  readonly name: string
  handle(
    repository: SpoolLibraryRepository,
    request: LegacyApiRequest,
  ): Promise<LegacyModuleResult>
}

export const respond = (
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Result<LegacyApiResponse> => ({
  ok: true,
  value: headers ? { status, body, headers } : { status, body },
})

/** Spoolman `Message` body. */
export const message = (status: number, text: string) =>
  respond(status, { message: text })

export const failure = (
  reason: SpoolLibraryFailureReason,
): Result<LegacyApiResponse> => ({ ok: false, reason })

/** FastAPI's answer for a known path with an unsupported method. */
export const methodNotAllowed = () =>
  respond(405, { detail: 'Method Not Allowed' })

export const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/**
 * Last value wins for a repeated query key, as in Starlette's `QueryParams`
 * (`URLSearchParams.get` returns the first).
 */
export function lastQueryValue(
  query: URLSearchParams,
  key: string,
): string | null {
  const all = query.getAll(key)
  return all.length ? (all[all.length - 1] as string) : null
}

/** `extra.<key>` query parameters, last value per key. */
export function extraQueryFilters(query: URLSearchParams): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of query)
    if (key.startsWith('extra.')) out.set(key.slice(6), value)
  return out
}
