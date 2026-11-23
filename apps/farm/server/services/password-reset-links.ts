import { randomBytes } from 'node:crypto'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { MembersError } from './members.ts'
import { resetTokenDigest } from './password-reset.ts'

/** Matches the database cap on farm.password_reset_tokens (migration 0020). */
export const RESET_LINK_TTL_MS = 15 * 60 * 1000

export interface IssuedResetLink {
  username: string
  expiresAt: Date
}
/** Why an owner may not reset an account that is otherwise in their farm. */
export interface ResetLinkRefusal {
  refused: 'self' | 'shared-account'
}
export interface ResetLinkStore {
  /**
   * One transaction: the actor is an active owner of the farm and the target an
   * active, enabled member with a password whose only active membership is this
   * farm. Replaces that account's only reset digest and binds it to the farm.
   * Null when the owner or membership check fails, so non-owners learn nothing;
   * a refusal when the target is the actor or also belongs to another farm.
   */
  issueForMember(
    actorId: string,
    farmId: string,
    accountId: string,
    digest: string,
  ): Promise<IssuedResetLink | ResetLinkRefusal | null>
}
export interface ResetLinkDeps {
  origin: string
  store: ResetLinkStore | undefined
  /** Rejects with the caller's own 401/503 error when there is no valid session. */
  authenticate(): Promise<{ accountId: string }>
  /** Rejects when the per-account budget is spent. */
  limit(key: string): Promise<void>
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const account = /^[A-Za-z0-9_-]{1,128}$/
const notFound = () => new MembersError(404, 'Recurso não encontrado.')

/** The token stays in the fragment, out of server logs and Referer. */
export function resetLinkUrl(
  origin: string,
  username: string,
  token: string,
): string {
  const fragment = new URLSearchParams({ usuario: username, codigo: token })
  return `${origin}/redefinir-senha#${fragment.toString()}`
}

/**
 * Owner-issued one-time reset link. The token is returned once and only its
 * SHA-256 digest is stored; issuing again replaces any earlier link.
 */
export async function issueResetLink(
  deps: ResetLinkDeps,
  request: Request,
  farmId: string,
  memberId: string,
): Promise<{ username: string; url: string; expiresAt: string }> {
  if (!deps.store) throw notFound()
  if (!checkMutationOrigin(request.headers.get('origin'), deps.origin).ok)
    throw new MembersError(403, 'Origem da solicitação não permitida.')
  const { accountId } = await deps.authenticate()
  await deps.limit('reset-link:' + accountId)
  if (!uuid.test(farmId) || !account.test(memberId)) throw notFound()
  const token = randomBytes(32).toString('base64url')
  const issued = await deps.store.issueForMember(
    accountId,
    farmId,
    memberId,
    resetTokenDigest(token),
  )
  if (!issued) throw notFound()
  if ('refused' in issued)
    throw issued.refused === 'self'
      ? new MembersError(
          409,
          'Use a alteração de senha da sua conta em vez de um link de redefinição.',
        )
      : new MembersError(
          409,
          'Esta conta também participa de outra fazenda; só ela pode redefinir a própria senha.',
        )
  return {
    username: issued.username,
    url: resetLinkUrl(deps.origin, issued.username, token),
    expiresAt: issued.expiresAt.toISOString(),
  }
}
