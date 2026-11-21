import { createLogger } from '@open3dfarmmanager/shared'
import { sanitizeUnhandledErrorPath } from './spool-library/legacy-path.ts'

const log = createLogger('farm-server')

/** Logs unhandled 5xx errors (redacted, path only, no query). Never throws. */
export function logUnhandledError(
  error: unknown,
  event?: { path?: unknown },
): void {
  try {
    const e = error as { statusCode?: unknown; status?: unknown } | null
    const status = e?.statusCode ?? e?.status
    if (typeof status === 'number' && status < 500) return
    log.error('unhandled-error', {
      error,
      path: sanitizeUnhandledErrorPath(event?.path),
    })
  } catch {
    // never throw from the error hook
  }
}
