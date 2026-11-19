import { GOOGLE_PROVIDER_PRESET } from './google-provider-preset.ts'
import type { OidcIdentity } from './oidc-login.ts'

export type GoogleLinkDirectory = {
  findLink(
    issuer: string,
    subject: string,
  ): Promise<{ accountId: string } | null>
  link(
    accountId: string,
    issuer: string,
    subject: string,
  ): Promise<
    'linked' | 'subject-taken' | 'issuer-linked' | 'unavailable' | 'rejected'
  >
}

/** A signed-in member may attach a verified Google subject to their own account. */
export async function decideGoogleAccountLink(
  identity: OidcIdentity & { readonly email: string },
  accountId: string,
  directory: GoogleLinkDirectory,
): Promise<
  | { ok: true; code: 'linked' | 'already' }
  | {
      ok: false
      code: 'wrong-provider' | 'taken' | 'issuer-linked' | 'unavailable'
    }
> {
  if (identity.issuer !== GOOGLE_PROVIDER_PRESET.issuer)
    return { ok: false, code: 'wrong-provider' }
  const existing = await directory.findLink(identity.issuer, identity.subject)
  if (existing) {
    if (existing.accountId === accountId) return { ok: true, code: 'already' }
    return { ok: false, code: 'taken' }
  }
  const result = await directory.link(
    accountId,
    identity.issuer,
    identity.subject,
  )
  switch (result) {
    case 'linked':
      return { ok: true, code: 'linked' }
    case 'subject-taken':
      return { ok: false, code: 'taken' }
    case 'issuer-linked':
      return { ok: false, code: 'issuer-linked' }
    case 'unavailable':
    case 'rejected':
      return { ok: false, code: 'unavailable' }
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

export function canUnlinkGoogle(input: {
  hasPassword: boolean
  googleLinked: boolean
  oidcLinked: boolean
}): boolean {
  if (!input.googleLinked) return false
  return input.hasPassword || input.oidcLinked
}

export function accountIdentitiesView(input: {
  googleAvailable: boolean
  googleLinked: boolean
  canUnlinkGoogle: boolean
}): {
  google: {
    available: boolean
    linked: boolean
    canUnlink: boolean
  }
} {
  return {
    google: {
      available: input.googleAvailable,
      linked: input.googleLinked,
      canUnlink: input.canUnlinkGoogle,
    },
  }
}
