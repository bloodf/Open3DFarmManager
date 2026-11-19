import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from 'openid-client'

export type OidcProtocolCode =
  'state' | 'nonce' | 'expired' | 'audience' | 'invalid'

/** Library refusal. `detail` is for tests; HTTP responses stay generic. */
export class OidcProtocolError extends Error {
  readonly code: OidcProtocolCode
  readonly detail: string
  constructor(code: OidcProtocolCode, detail: string) {
    super(code)
    this.name = 'OidcProtocolError'
    this.code = code
    this.detail = detail
  }
}

export interface OidcTransaction {
  state: string
  nonce: string
  codeVerifier: string
}

export interface OidcIdentity {
  readonly issuer: string
  readonly subject: string
}

export interface OidcDirectory {
  findLink(
    issuer: string,
    subject: string,
  ): Promise<{ accountId: string } | null>
  /** Role comes from the invite row inside the store. This argument has no role field. */
  linkThroughInvite(input: {
    issuer: string
    subject: string
    username: string
    inviteDigest: string
  }): Promise<{ accountId: string; role: string } | null>
}

const CALLBACK_PARAMS = [
  'code',
  'state',
  'iss',
  'error',
  'error_description',
] as const

function messages(error: unknown): string[] {
  const found: string[] = []
  let current = error
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    found.push(current.message)
    current = current.cause
  }
  return found
}

export function classifyOidcProtocolError(error: unknown): OidcProtocolError {
  if (error instanceof OidcProtocolError) return error
  const detail = messages(error).join('\n').slice(0, 300)
  if (detail.includes('unexpected "state" response parameter'))
    return new OidcProtocolError('state', detail)
  if (detail.includes('response parameter "state" missing'))
    return new OidcProtocolError('state', detail)
  if (detail.includes('unexpected ID Token "nonce" claim value'))
    return new OidcProtocolError('nonce', detail)
  if (detail.includes('expiration is past current timestamp'))
    return new OidcProtocolError('expired', detail)
  if (
    detail.includes('unexpected JWT "aud" (audience) claim value') ||
    detail.includes('additional untrusted audiences')
  )
    return new OidcProtocolError('audience', detail)
  return new OidcProtocolError('invalid', detail)
}

/** Authorization code + S256 PKCE, with fresh state and nonce. Scope is only `openid`. */
export async function beginOidcAuthorization(
  config: Configuration,
  redirectUri: string,
): Promise<OidcTransaction & { url: URL }> {
  const codeVerifier = randomPKCECodeVerifier()
  const state = randomState()
  const nonce = randomNonce()
  const url = buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid',
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  })
  return { url, state, nonce, codeVerifier }
}

/** Copies only the OAuth response parameters onto the configured redirect URI. */
export function oidcCallbackUrl(redirectUri: string, incoming: URL): URL {
  const current = new URL(redirectUri)
  for (const key of CALLBACK_PARAMS) {
    const value = incoming.searchParams.get(key)
    if (value !== null) current.searchParams.set(key, value)
  }
  return current
}

/**
 * Exchanges the code and returns the verified issuer and subject.
 * Email claims stay internal until a provider-specific policy accepts them.
 */
/** Provider policies that accept email claims must validate them before use. */
export async function finishOidcClaims(
  config: Configuration,
  currentUrl: URL,
  transaction: OidcTransaction,
): Promise<OidcIdentity & { email?: unknown; email_verified?: unknown }> {
  try {
    const tokens = await authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    })
    const claims = tokens.claims()
    if (!claims) throw new OidcProtocolError('invalid', 'missing id token')
    const issuer = claims.iss
    const subject = claims.sub
    if (
      typeof issuer !== 'string' ||
      typeof subject !== 'string' ||
      issuer.length < 8 ||
      issuer.length > 512 ||
      subject.length < 1 ||
      subject.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(subject)
    )
      throw new OidcProtocolError('invalid', 'rejected identity')
    return Object.freeze({
      issuer,
      subject,
      email: claims.email,
      email_verified: claims.email_verified,
    })
  } catch (error) {
    throw classifyOidcProtocolError(error)
  }
}

/** Generic OIDC deliberately does not expose provider email claims. */
export async function finishOidcAuthorization(
  config: Configuration,
  currentUrl: URL,
  transaction: OidcTransaction,
): Promise<OidcIdentity> {
  const { issuer, subject } = await finishOidcClaims(
    config,
    currentUrl,
    transaction,
  )
  return Object.freeze({ issuer, subject })
}

export const usernamePattern = /^[a-z0-9_-]{3,64}$/
export const digestPattern = /^[a-f0-9]{64}$/

/**
 * An existing link signs in as that account.
 * A new link is created only from a valid invite. Nothing is matched by email.
 */
export async function decideOidcAccount(
  identity: OidcIdentity,
  pending: { username?: string; inviteDigest?: string } | undefined,
  directory: OidcDirectory,
): Promise<
  | { ok: true; accountId: string; created: boolean; role: string | null }
  | { ok: false; code: 'unlinked' }
> {
  const existing = await directory.findLink(identity.issuer, identity.subject)
  if (existing)
    return {
      ok: true,
      accountId: existing.accountId,
      created: false,
      role: null,
    }
  const username = pending?.username
  const inviteDigest = pending?.inviteDigest
  if (
    username === undefined ||
    inviteDigest === undefined ||
    !usernamePattern.test(username) ||
    !digestPattern.test(inviteDigest)
  )
    return { ok: false, code: 'unlinked' }
  const linked = await directory.linkThroughInvite({
    issuer: identity.issuer,
    subject: identity.subject,
    username,
    inviteDigest,
  })
  if (!linked) return { ok: false, code: 'unlinked' }
  return {
    ok: true,
    accountId: linked.accountId,
    created: true,
    role: linked.role,
  }
}
