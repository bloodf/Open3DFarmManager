import {
  parseLegacyToken,
  type ParsedLegacyToken,
} from '../../storage/spool-library-credential.ts'

/**
 * Legacy clients are pointed at `<origin>/spoolman/<token>` and append their
 * usual `/api/v1/...` themselves. Split that request path into the credential
 * token and the Spoolman API path, without decoding or normalising either.
 */
export const LEGACY_MOUNT = '/spoolman'

export type LegacyPathResult =
  | { ok: true; token: string; parsed: ParsedLegacyToken; apiPath: string }
  | { ok: false }

/** Drop the credential segment so a request path can be logged. */
export function sanitizeUnhandledErrorPath(path: unknown): string {
  const pathOnly = String(path ?? '').split('?')[0]
  return pathOnly.replace(/^(\/spoolman\/)[^/]+/, '$1<redacted>')
}

export function splitLegacyPath(pathname: string): LegacyPathResult {
  if (typeof pathname !== 'string' || pathname.length > 512)
    return { ok: false }
  const prefix = `${LEGACY_MOUNT}/`
  if (!pathname.startsWith(prefix)) return { ok: false }
  const rest = pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  const token = slash === -1 ? rest : rest.slice(0, slash)
  const apiPath = slash === -1 ? '/' : rest.slice(slash)
  const parsed = parseLegacyToken(token)
  if (!parsed || /%|\.\.|\/\//.test(apiPath)) return { ok: false }
  return { ok: true, token, parsed, apiPath }
}
