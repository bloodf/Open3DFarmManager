import { randomBytes } from 'node:crypto'
import { hashPassword } from './auth/password.ts'
import type { AuthRuntime } from './auth/runtime.ts'
import type { Configuration } from 'openid-client'
import {
  decideGoogleAccount,
  finishGoogleAuthorization,
  type GoogleDirectory,
  type OidcTransaction,
} from './oidc-login.ts'

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
