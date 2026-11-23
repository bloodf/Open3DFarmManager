/**
 * The external filament library module wired from deployment settings.
 * `SPOOLMAN_EXTERNAL_DB_URL` names a SpoolmanDB-style base URL (serving
 * `filaments.json` and `materials.json`); without it no catalog is ever
 * fetched and the endpoints answer as upstream does before its first sync.
 * Fetching happens in the background, never inside a farm transaction, and
 * never carries a request credential.
 */
import {
  createExternalFilamentCatalog,
  createExternalFilamentModule,
} from './external-filament.ts'
import type { LegacyApiModule } from './types.ts'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const RETRY_AFTER_MS = 60 * 1000

export function createConfiguredExternalModule(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): LegacyApiModule {
  const raw = env['SPOOLMAN_EXTERNAL_DB_URL']
  let baseUrl: string | undefined
  try {
    const url = raw ? new URL(raw) : undefined
    if (url && (url.protocol === 'https:' || url.protocol === 'http:'))
      baseUrl = url.href.endsWith('/') ? url.href : `${url.href}/`
  } catch {
    baseUrl = undefined
  }
  const catalog = createExternalFilamentCatalog(
    baseUrl ?? 'http://127.0.0.1:9/',
    fetcher,
  )
  const inner = createExternalFilamentModule(catalog)
  let refreshedAt = 0
  let attemptedAt = 0
  let inflight = false
  const kick = () => {
    if (!baseUrl || inflight) return
    const now = clock()
    const stale =
      catalog.snapshot === undefined || now - refreshedAt >= REFRESH_AFTER_MS
    if (!stale || now - attemptedAt < RETRY_AFTER_MS) return
    inflight = true
    attemptedAt = now
    catalog
      .refresh()
      .then(() => {
        refreshedAt = clock()
      })
      .catch(() => {})
      .finally(() => {
        inflight = false
      })
  }
  return {
    name: inner.name,
    handle(repository, request) {
      if (request.apiPath.startsWith('/api/v1/external/')) kick()
      return inner.handle(repository, request)
    },
  }
}
