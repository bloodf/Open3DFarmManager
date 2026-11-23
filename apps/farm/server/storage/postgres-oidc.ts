import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { googleInviteAllowed } from '../utils/oidc-google-rules.ts'

const roles = ['admin', 'operator', 'viewer'] as const
type InviteRole = (typeof roles)[number]

/** Issuer and subject only. Provider email and role claims are not columns. */
export class PostgresOidc {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }
  async findLink(
    issuer: string,
    subject: string,
  ): Promise<{ accountId: string } | null> {
    const rows = await this
      .sql`SELECT i.account_id AS "accountId" FROM farm.oidc_identities i
      JOIN farm.session_accounts a ON a.id = i.account_id AND NOT a.disabled
      WHERE i.issuer = ${issuer} AND i.subject = ${subject}`
    const accountId = rows[0]?.accountId
    return typeof accountId === 'string' ? { accountId } : null
  }
  /**
   * Consumes one invite and creates the account, membership and identity.
   * Membership role is the invite row's role. There is no role argument.
   */
  async linkThroughInvite(input: {
    issuer: string
    subject: string
    username: string
    inviteDigest: string
    passwordHash: string
  }): Promise<{ accountId: string; role: InviteRole } | null> {
    if (
      input.passwordHash.length < 32 ||
      input.passwordHash.length > 1024 ||
      input.issuer.length < 8 ||
      input.issuer.length > 512 ||
      input.subject.length < 1 ||
      input.subject.length > 256
    )
      return null
    return await this.sql
      .begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const invites =
          await tx`SELECT i.id, i.farm_id, i.role FROM farm.account_invites i
          JOIN farm.memberships m ON m.farm_id = i.farm_id AND m.account_id = i.created_by AND m.role = 'owner' AND m.revoked_at IS NULL
          JOIN farm.session_accounts a ON a.id = i.created_by AND NOT a.disabled
          WHERE i.digest = ${input.inviteDigest} AND i.bound_email IS NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > clock_timestamp() FOR UPDATE OF i FOR SHARE OF m, a`
        const invite = invites[0]
        if (
          !invite ||
          (invite.role !== 'admin' &&
            invite.role !== 'operator' &&
            invite.role !== 'viewer')
        )
          return null
        const role: InviteRole = invite.role
        const accountId = randomUUID()
        await tx`INSERT INTO farm.session_accounts (id) VALUES (${accountId})`
        const created =
          await tx`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${accountId}, ${input.username}, ${input.passwordHash}) ON CONFLICT (username) DO NOTHING RETURNING account_id`
        if (!created.length) throw new OidcLinkRollback()
        await tx`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${invite.farm_id}, ${accountId}, ${role})`
        await tx`INSERT INTO farm.oidc_identities (issuer, subject, account_id) VALUES (${input.issuer}, ${input.subject}, ${accountId})`
        await tx`UPDATE farm.account_invites SET consumed_at = clock_timestamp(), consumed_by = ${accountId} WHERE id = ${invite.id}`
        return { accountId, role }
      })
      .catch((error: unknown) => {
        if (error instanceof OidcLinkRollback) return null
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        )
          return null
        throw error
      })
  }
  /** Redeems a bound invitation or admits a verified email to matching domains. */
  async signInGoogle(input: {
    issuer: string
    subject: string
    email: string
    username?: string | undefined
    inviteDigest?: string | undefined
    passwordHash?: string | undefined
  }): Promise<{ accountId: string; created: boolean } | null> {
    const domain = input.email.split('@')[1]
    if (!domain || input.email !== input.email.toLowerCase()) return null
    return await this.sql
      .begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const existing =
          await tx`SELECT i.account_id FROM farm.oidc_identities i JOIN farm.session_accounts a ON a.id = i.account_id AND NOT a.disabled WHERE i.issuer = ${input.issuer} AND i.subject = ${input.subject}`
        let accountId: string
        let created = false
        if (existing[0] && typeof existing[0].account_id === 'string') {
          if (input.inviteDigest) return null
          accountId = existing[0].account_id
        } else {
          if (
            !input.username ||
            !input.passwordHash ||
            input.passwordHash.length < 32 ||
            input.passwordHash.length > 1024
          )
            return null
          const matching =
            await tx`SELECT farm_id FROM farm.sign_in_rules WHERE mode = 'allowed-domains' AND ${domain} = ANY(allowed_domains) FOR SHARE`
          let invite: { id: string; farm_id: string; role: string } | undefined
          if (input.inviteDigest) {
            const rows =
              await tx`SELECT i.id, i.farm_id, i.role, i.bound_email, COALESCE(r.mode, 'invite-only') AS mode FROM farm.account_invites i
            JOIN farm.memberships m ON m.farm_id = i.farm_id AND m.account_id = i.created_by AND m.role = 'owner' AND m.revoked_at IS NULL
            JOIN farm.session_accounts a ON a.id = i.created_by AND NOT a.disabled
            LEFT JOIN farm.sign_in_rules r ON r.farm_id = i.farm_id
            WHERE i.digest = ${input.inviteDigest} AND i.bound_email = ${input.email} AND i.role IN ('operator', 'viewer')
              AND COALESCE(r.mode, 'invite-only') <> 'link-only'
              AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > clock_timestamp()
            FOR UPDATE OF i FOR SHARE OF m, a`
            const row = rows[0]
            if (
              row &&
              typeof row.id === 'string' &&
              typeof row.farm_id === 'string' &&
              typeof row.role === 'string' &&
              googleInviteAllowed({
                verifiedEmail: input.email,
                boundEmail: row.bound_email,
                role: row.role,
                mode: row.mode,
              })
            )
              invite = { id: row.id, farm_id: row.farm_id, role: row.role }
            // An explicitly supplied invalid invite is never bypassed by a domain rule.
            if (!invite) return null
          }
          if (!invite && !matching.length) return null
          accountId = randomUUID()
          await tx`INSERT INTO farm.session_accounts (id) VALUES (${accountId})`
          const credential =
            await tx`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${accountId}, ${input.username}, ${input.passwordHash}) ON CONFLICT (username) DO NOTHING RETURNING account_id`
          if (!credential.length) throw new OidcLinkRollback()
          await tx`INSERT INTO farm.oidc_identities (issuer, subject, account_id) VALUES (${input.issuer}, ${input.subject}, ${accountId})`
          if (invite) {
            await tx`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${invite.farm_id}, ${accountId}, ${invite.role})`
            await tx`UPDATE farm.account_invites SET consumed_at = clock_timestamp(), consumed_by = ${accountId} WHERE id = ${invite.id}`
          }
          created = true
        }
        await tx`INSERT INTO farm.memberships (farm_id, account_id, role)
        SELECT farm_id, ${accountId}, 'viewer' FROM farm.sign_in_rules
        WHERE mode = 'allowed-domains' AND ${domain} = ANY(allowed_domains)
        ON CONFLICT (farm_id, account_id) DO NOTHING`
        return { accountId, created }
      })
      .catch((error: unknown) => {
        if (
          error instanceof OidcLinkRollback ||
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505')
        )
          return null
        throw error
      })
  }
}

class OidcLinkRollback extends Error {}
