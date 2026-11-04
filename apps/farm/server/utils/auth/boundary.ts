/** Configuration only: no cookie is issued and no session is authenticated here. */
export const SESSION_COOKIE_NAME = '__Host-open3dfarmmanager-session'
export const SESSION_COOKIE_ATTRIBUTES = Object.freeze({
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/' as const,
})

export type OriginDecision =
  | { ok: true }
  | { ok: false; reason: 'missing-origin' | 'invalid-origin' | 'cross-origin' }

/** Must come from trusted deployment configuration, never Host/Forwarded headers. */
export function configuredAuthOrigin(value: string): string {
  try {
    if (
      typeof value !== 'string' ||
      value.length > 2048 ||
      value.trim() !== value ||
      /[\u0000-\u0020\u007f\\]/.test(value)
    )
      throw new Error()
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.origin
  } catch {
    throw new Error('Invalid authentication origin configuration')
  }
}

/** CSRF boundary for future cookie-authenticated mutations; not an authentication check. */
export function checkMutationOrigin(
  originHeader: unknown,
  trustedOrigin: string,
): OriginDecision {
  const expected = configuredAuthOrigin(trustedOrigin)
  if (originHeader === undefined || originHeader === null)
    return { ok: false, reason: 'missing-origin' }
  if (typeof originHeader !== 'string' || originHeader.length > 2048)
    return { ok: false, reason: 'invalid-origin' }
  let actual: string
  try {
    const url = new URL(originHeader)
    // Browser Origin serialization contains only scheme, host and port. No lists or paths.
    if (url.protocol !== 'https:' || url.origin !== originHeader)
      return { ok: false, reason: 'invalid-origin' }
    actual = url.origin
  } catch {
    return { ok: false, reason: 'invalid-origin' }
  }
  return actual === expected
    ? { ok: true }
    : { ok: false, reason: 'cross-origin' }
}
