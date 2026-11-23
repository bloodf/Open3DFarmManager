import type { Sql } from 'postgres'

export type SignInRules = {
  mode: 'link-only' | 'invite-only' | 'allowed-domains'
  allowedDomains: string[]
}

export function parseSignInRules(value: unknown): SignInRules | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('mode' in value) ||
    !('allowedDomains' in value) ||
    Object.keys(value).length !== 2
  )
    return null
  if (
    value.mode !== 'link-only' &&
    value.mode !== 'invite-only' &&
    value.mode !== 'allowed-domains'
  )
    return null
  if (!Array.isArray(value.allowedDomains) || value.allowedDomains.length > 100)
    return null
  const domains: string[] = []
  for (const item of value.allowedDomains) {
    if (typeof item !== 'string' || item.length > 253) return null
    const domain = item.toLowerCase()
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        domain,
      )
    )
      return null
    if (!domains.includes(domain)) domains.push(domain)
  }
  if (value.mode !== 'allowed-domains' && domains.length) return null
  return { mode: value.mode, allowedDomains: domains }
}

export class PostgresSignInRules {
  private readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
  }

  async access(
    actorId: string,
    farmId: string,
    update?: SignInRules,
  ): Promise<SignInRules | null> {
    return await this.sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`
      await tx`SET LOCAL lock_timeout = '1000ms'`
      const owners =
        await tx`SELECT 1 FROM farm.memberships m JOIN farm.session_accounts a ON a.id = m.account_id WHERE m.farm_id = ${farmId}::uuid AND m.account_id = ${actorId} AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT a.disabled FOR SHARE OF m, a`
      if (!owners.length) return null
      if (update) {
        await tx`INSERT INTO farm.sign_in_rules (farm_id, mode, allowed_domains) VALUES (${farmId}::uuid, ${update.mode}, ${update.allowedDomains}::text[]) ON CONFLICT (farm_id) DO UPDATE SET mode = EXCLUDED.mode, allowed_domains = EXCLUDED.allowed_domains`
        return update
      }
      const rows =
        await tx`SELECT mode, allowed_domains FROM farm.sign_in_rules WHERE farm_id = ${farmId}::uuid`
      if (!rows.length) return { mode: 'invite-only', allowedDomains: [] }
      return parseSignInRules({
        mode: rows[0]?.mode,
        allowedDomains: rows[0]?.allowed_domains,
      })
    })
  }
}
