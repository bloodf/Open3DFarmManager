import { configuredAuthOrigin } from './auth/boundary.ts'

/** One configured provider. No client id or issuer is built in. */
export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  origin: string
}

export type OidcConfigResult =
  | { state: 'off' }
  | { state: 'invalid' }
  | { state: 'ready'; settings: OidcSettings }

const visible = (value: string, max: number) =>
  value.length >= 1 && value.length <= max && /^[\x21-\x7E]+$/.test(value)

/** Exact issuer string. HTTPS only; userinfo, query and hash are rejected. */
function issuerIdentifier(value: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim())
    return
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return
    return url.pathname === '/' ? url.origin : url.href.replace(/\/$/, '')
  } catch {
    return
  }
}

/**
 * OIDC is off unless `auth.oidc` is exactly true.
 * A true flag with missing auth or an invalid issuer is `invalid`, not silently on.
 */
export function readOidcConfig(auth: unknown): OidcConfigResult {
  if (typeof auth !== 'object' || auth === null || !('oidc' in auth))
    return { state: 'off' }
  if (auth.oidc !== true) return { state: 'off' }
  if (!('enabled' in auth) || auth.enabled !== true) return { state: 'invalid' }
  try {
    if (!('origin' in auth) || typeof auth.origin !== 'string')
      return { state: 'invalid' }
    const origin = configuredAuthOrigin(auth.origin)
    const issuer =
      'oidcIssuer' in auth && typeof auth.oidcIssuer === 'string'
        ? issuerIdentifier(auth.oidcIssuer)
        : undefined
    const clientId =
      'oidcClientId' in auth && typeof auth.oidcClientId === 'string'
        ? auth.oidcClientId
        : ''
    if (!issuer || !visible(clientId, 200)) return { state: 'invalid' }
    let clientSecret: string | undefined
    if ('oidcClientSecret' in auth && auth.oidcClientSecret !== '') {
      if (typeof auth.oidcClientSecret !== 'string') return { state: 'invalid' }
      if (!visible(auth.oidcClientSecret, 512)) return { state: 'invalid' }
      clientSecret = auth.oidcClientSecret
    }
    const settings: OidcSettings = {
      issuer,
      clientId,
      redirectUri: origin + '/api/auth/oidc/callback',
      origin,
    }
    if (clientSecret !== undefined) settings.clientSecret = clientSecret
    return { state: 'ready', settings }
  } catch {
    return { state: 'invalid' }
  }
}
