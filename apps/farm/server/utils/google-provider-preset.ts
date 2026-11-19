/** Built-in Google sign-in preset. No client id or secret is shipped. */
export const GOOGLE_PROVIDER_ID = 'google' as const

export const GOOGLE_PROVIDER_PRESET = Object.freeze({
  id: GOOGLE_PROVIDER_ID,
  issuer: 'https://accounts.google.com',
  scopes: Object.freeze(['openid', 'email', 'profile'] as const),
  scope: 'openid email profile',
  pkce: true,
  emailVerifiedRequired: true,
  redirectPath: '/api/auth/google/callback',
})

export type GoogleProviderPublicView = {
  id: typeof GOOGLE_PROVIDER_ID
  enabled: boolean
  clientId: string
  hasClientSecret: boolean
  redirectUri: string
  issuer: string
  scopes: readonly string[]
  pkce: true
  emailVerifiedRequired: true
}

export type GoogleSignInStatus =
  | { enabled: true }
  | { enabled: false; reason: 'disabled' | 'not-configured' | 'offline' }

export function googleRedirectUri(origin: string): string {
  return origin.replace(/\/$/, '') + GOOGLE_PROVIDER_PRESET.redirectPath
}

export function googlePublicView(input: {
  origin: string
  enabled: boolean
  clientId: string
  hasClientSecret: boolean
}): GoogleProviderPublicView {
  return {
    id: GOOGLE_PROVIDER_ID,
    enabled: input.enabled,
    clientId: input.clientId,
    hasClientSecret: input.hasClientSecret,
    redirectUri: googleRedirectUri(input.origin),
    issuer: GOOGLE_PROVIDER_PRESET.issuer,
    scopes: [...GOOGLE_PROVIDER_PRESET.scopes],
    pkce: true,
    emailVerifiedRequired: true,
  }
}

/** Public sign-in button status. Never includes credentials. */
export function googleSignInStatus(input: {
  enabled: boolean
  clientId: string
  hasClientSecret: boolean
  offline?: boolean
}): GoogleSignInStatus {
  if (input.offline) return { enabled: false, reason: 'offline' }
  if (!input.enabled) return { enabled: false, reason: 'disabled' }
  if (!input.clientId || !input.hasClientSecret)
    return { enabled: false, reason: 'not-configured' }
  return { enabled: true }
}

const visible = (value: string, max: number) =>
  value.length >= 1 && value.length <= max && /^[\x21-\x7E]+$/.test(value)

export type GoogleProviderWrite =
  | { ok: false }
  | {
      ok: true
      enabled: boolean
      clientId: string
      /** Undefined keeps the stored secret. */
      clientSecret?: string
    }

/** Admin write body. `clientSecret` omitted or empty keeps the existing secret. */
export function parseGoogleProviderWrite(value: unknown): GoogleProviderWrite {
  if (typeof value !== 'object' || value === null) return { ok: false }
  const keys = Object.keys(value)
  if (keys.length < 2 || keys.length > 3) return { ok: false }
  if (!('enabled' in value) || typeof value.enabled !== 'boolean')
    return { ok: false }
  if (!('clientId' in value) || typeof value.clientId !== 'string')
    return { ok: false }
  if (value.clientId !== '' && !visible(value.clientId, 200))
    return { ok: false }
  let clientSecret: string | undefined
  if ('clientSecret' in value) {
    if (typeof value.clientSecret !== 'string') return { ok: false }
    if (value.clientSecret !== '') {
      if (!visible(value.clientSecret, 512)) return { ok: false }
      clientSecret = value.clientSecret
    }
  }
  if (value.enabled && value.clientId === '') return { ok: false }
  const result: {
    ok: true
    enabled: boolean
    clientId: string
    clientSecret?: string
  } = { ok: true, enabled: value.enabled, clientId: value.clientId }
  if (clientSecret !== undefined) result.clientSecret = clientSecret
  return result
}

/** Installation admins are owners or admins of any farm; operators and members are refused. */
export function isInstallationAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin'
}
