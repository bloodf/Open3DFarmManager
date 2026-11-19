import type { Sql } from 'postgres'
import { GOOGLE_PROVIDER_PRESET } from '../utils/google-provider-preset.ts'

export type IdentityLinkCode =
  'linked' | 'subject-taken' | 'issuer-linked' | 'unavailable' | 'rejected'

export type IdentityUnlinkCode =
  'unlinked' | 'not-linked' | 'last-method' | 'unavailable' | 'rejected'

function sqlDetail(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message
  return ''
}

export class PostgresIdentities {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  async accountSignInMethods(accountId: string): Promise<{
    hasPassword: boolean
    googleLinked: boolean
    oidcLinked: boolean
  } | null> {
    const rows = await this.sql`SELECT EXISTS (
        SELECT 1 FROM farm.password_credentials c WHERE c.account_id = ${accountId}
      ) AS "hasPassword",
      EXISTS (
        SELECT 1 FROM farm.oidc_identities i
        JOIN farm.session_accounts a ON a.id = i.account_id AND NOT a.disabled
        WHERE i.account_id = ${accountId} AND i.issuer = ${GOOGLE_PROVIDER_PRESET.issuer}
      ) AS "googleLinked",
      EXISTS (
        SELECT 1 FROM farm.oidc_identities i
        JOIN farm.session_accounts a ON a.id = i.account_id AND NOT a.disabled
        WHERE i.account_id = ${accountId} AND i.issuer <> ${GOOGLE_PROVIDER_PRESET.issuer}
      ) AS "oidcLinked"
      FROM farm.session_accounts a WHERE a.id = ${accountId} AND NOT a.disabled`
    const row = rows[0]
    if (!row) return null
    return {
      hasPassword: row.hasPassword === true,
      googleLinked: row.googleLinked === true,
      oidcLinked: row.oidcLinked === true,
    }
  }

  async link(
    accountId: string,
    issuer: string,
    subject: string,
  ): Promise<IdentityLinkCode> {
    try {
      await this
        .sql`SELECT farm.link_oidc_identity(${accountId}, ${issuer}, ${subject})`
      return 'linked'
    } catch (error: unknown) {
      const detail = sqlDetail(error)
      if (detail.includes('oidc_subject_taken')) return 'subject-taken'
      if (detail.includes('oidc_issuer_linked')) return 'issuer-linked'
      if (detail.includes('oidc_account_unavailable')) return 'unavailable'
      if (detail.includes('oidc_link_rejected')) return 'rejected'
      throw error
    }
  }

  async unlink(accountId: string, issuer: string): Promise<IdentityUnlinkCode> {
    try {
      await this.sql`SELECT farm.unlink_oidc_identity(${accountId}, ${issuer})`
      return 'unlinked'
    } catch (error: unknown) {
      const detail = sqlDetail(error)
      if (detail.includes('oidc_not_linked')) return 'not-linked'
      if (detail.includes('oidc_last_sign_in_method')) return 'last-method'
      if (detail.includes('oidc_account_unavailable')) return 'unavailable'
      if (detail.includes('oidc_unlink_rejected')) return 'rejected'
      throw error
    }
  }
}
