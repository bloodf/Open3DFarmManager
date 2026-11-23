/**
 * Upstream's trusted-origin rule for browser writes and websocket handshakes
 * (`spoolman/security.py`, with no `SPOOLMAN_CORS_ORIGIN` configured): a
 * request without an `Origin` is a non-browser client and is trusted; one with
 * an `Origin` must name the host the request was made to (or the first entry
 * of `X-Forwarded-Host`).
 */

const DEFAULT_PORTS: Record<string, string> = { http: ':80', https: ':443' }

/** `Host`-style value as upstream compares it (`:80` and `:443` dropped). */
function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase()
  if (value.endsWith(':80')) value = value.slice(0, -3)
  if (value.endsWith(':443')) value = value.slice(0, -4)
  return value
}

/** Authority of a normalised origin, `''` when it has no host part. */
function authority(origin: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/.exec(origin)
  if (!match) return ''
  const netloc = match[2] ?? ''
  const port = DEFAULT_PORTS[match[1] ?? '']
  return port && netloc.endsWith(port) ? netloc.slice(0, -port.length) : netloc
}

export function isTrustedOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
  forwardedHost?: string | null,
): boolean {
  if (origin === null || origin === undefined || origin.trim() === '')
    return true
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase()
  if (normalized === 'null') return false
  const own = new Set([normalizeHost(host ?? '')])
  if (forwardedHost) own.add(normalizeHost(forwardedHost.split(',')[0] ?? ''))
  own.delete('')
  const claimed = authority(normalized)
  return claimed !== '' && own.has(claimed)
}

/** Upstream's 403 for a browser write from an origin it does not trust. */
export const UNTRUSTED_ORIGIN_MESSAGE =
  'Request refused: it came from an origin this Spoolman instance does not trust. Set SPOOLMAN_CORS_ORIGIN if this origin should be allowed.'
