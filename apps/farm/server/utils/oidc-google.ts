import { randomBytes } from 'node:crypto'
import { hashPassword } from './auth/password.ts'
import type { AuthRuntime } from './auth/runtime.ts'
import type { Configuration } from 'openid-client'
import {
  beginOidcAuthorization,
  digestPattern,
  finishOidcClaims,
  OidcProtocolError,
  usernamePattern,
  type OidcIdentity,
  type OidcTransaction,
} from './oidc-login.ts'
import { GOOGLE_PROVIDER_PRESET } from './google-provider-preset.ts'

/** Google needs email and profile so the verified email claim is present. */
export async function beginGoogleAuthorization(
  config: Configuration,
  redirectUri: string,
) {
  const begun = await beginOidcAuthorization(config, redirectUri)
  begun.url.searchParams.set('scope', GOOGLE_PROVIDER_PRESET.scope)
  return begun
}

/** Call only for the Google provider after normal OIDC token validation. */
export async function finishGoogleAuthorization(
  config: Configuration,
  currentUrl: URL,
  transaction: OidcTransaction,
): Promise<OidcIdentity & { readonly email: string }> {
  const claims = await finishOidcClaims(config, currentUrl, transaction)
  if (
    claims.email_verified !== true ||
    typeof claims.email !== 'string' ||
    claims.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
  )
    throw new OidcProtocolError('invalid', 'verified email required')
  return Object.freeze({
    issuer: claims.issuer,
    subject: claims.subject,
    email: claims.email.toLowerCase(),
  })
}

export interface GoogleDirectory {
  signInGoogle(input: {
    issuer: string
    subject: string
    email: string
    username?: string | undefined
    inviteDigest?: string | undefined
  }): Promise<{ accountId: string; created: boolean } | null>
}

/** Only pass identities returned by finishGoogleAuthorization to this function. */
export async function decideGoogleAccount(
  identity: OidcIdentity & { readonly email: string },
  pending: { username?: string | undefined; inviteDigest?: string | undefined },
  directory: GoogleDirectory,
): Promise<
  | { ok: true; accountId: string; created: boolean }
  | { ok: false; code: 'unlinked' }
> {
  if (pending.username !== undefined && !usernamePattern.test(pending.username))
    return { ok: false, code: 'unlinked' }
  if (
    pending.inviteDigest !== undefined &&
    !digestPattern.test(pending.inviteDigest)
  )
    return { ok: false, code: 'unlinked' }
  const result = await directory.signInGoogle({ ...identity, ...pending })
  return result ? { ok: true, ...result } : { ok: false, code: 'unlinked' }
}

/** Provider callbacks use this adapter after verifying the Google ID token. */
export function googleDirectory(runtime: AuthRuntime): GoogleDirectory {
  return {
    async signInGoogle(input) {
      if (!runtime.oidc) throw new Error('Google account store unavailable')
      const passwordHash = input.username
        ? await hashPassword(randomBytes(32).toString('base64url'))
        : undefined
      return runtime.oidc.signInGoogle({ ...input, passwordHash })
    },
  }
}

/** Verify the token before evaluating any account rule or creating membership. */
export async function completeGoogleSignIn(
  config: Configuration,
  callback: URL,
  transaction: OidcTransaction,
  pending: { username?: string | undefined; inviteDigest?: string | undefined },
  runtime: AuthRuntime,
) {
  const identity = await finishGoogleAuthorization(
    config,
    callback,
    transaction,
  )
  return decideGoogleAccount(identity, pending, googleDirectory(runtime))
}
