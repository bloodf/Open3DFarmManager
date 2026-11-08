import type { Sql } from 'postgres'
import {
  PostgresConnectorCredentialRenewal,
  type RenewalConfig,
} from '../storage/postgres-connector-credential-renewal.ts'
import { createCredentialRenewalHttpHandler } from './credential-renewal-http.ts'
/** Caller provides keys and pool explicitly. Nothing is loaded from environment or activated at import. */
export async function createCredentialRenewalHttpRuntime(input: {
  sql: Sql
  config: RenewalConfig
  bodyTimeoutMs: number
}) {
  const result = (
    await input.sql`SELECT
    pg_has_role(current_user,'farm_connector_credential_renewer','USAGE') AND NOT has_schema_privilege(current_user,'farm','CREATE') AND NOT EXISTS(
      SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname NOT IN(current_user,'farm_connector_credential_renewer'))
    ) AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='farm' AND pg_has_role(current_user,n.nspowner,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='farm' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS allowed`
  )[0]
  if (result?.allowed !== true) throw new Error('Invalid renewal database role')
  // Verify exact direct role grants, including inherited column ACLs; reject accidental broadening.
  const tablePrivileges =
    await input.sql`SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee IN(current_user,'farm_connector_credential_renewer','PUBLIC') AND table_schema='farm'`
  const allowed: Record<string, ReadonlySet<string>> = {
    connector_enrollments: new Set(['SELECT']),
    connector_credentials: new Set(['SELECT']),
    connector_credential_successors: new Set(['SELECT', 'INSERT']),
    connector_revocations: new Set(['SELECT']),
    connector_credential_renewals: new Set(['SELECT', 'INSERT']),
  }
  if (
    tablePrivileges.some(
      (row) => !allowed[row.table_name]?.has(row.privilege_type),
    )
  )
    throw new Error('Unexpected renewal table privilege')
  const columns =
    await input.sql`SELECT table_name,column_name FROM information_schema.role_column_grants WHERE grantee IN(current_user,'farm_connector_credential_renewer','PUBLIC') AND table_schema='farm' AND privilege_type='UPDATE'`
  const mutable = new Set([
    'state',
    'parent_observed_at',
    'parent_expired_at',
    'child_observed_at',
    'child_expired_at',
    'reservation',
    'challenge',
    'consumed',
    'attempt',
    'committed_child_jti',
    'result_token_sha256',
    'authorized_at',
  ])
  if (
    columns.some((row) =>
      row.table_name === 'connector_credential_renewals'
        ? !mutable.has(row.column_name)
        : row.table_name === 'connector_enrollments'
          ? row.column_name !== 'agent_id'
          : ![
              'connector_credentials',
              'connector_credential_successors',
            ].includes(row.table_name) || row.column_name !== 'jti',
    )
  )
    throw new Error('Unexpected renewal column privilege')
  return createCredentialRenewalHttpHandler(
    new PostgresConnectorCredentialRenewal(input.sql, input.config),
    input.bodyTimeoutMs,
  )
}
type Handler = Awaited<ReturnType<typeof createCredentialRenewalHttpRuntime>>
let active: Handler | undefined
/** Future trusted lifecycle owner only; this function is never called by routes/imports. */
export async function activateCredentialRenewalHttpRuntime(
  input: Parameters<typeof createCredentialRenewalHttpRuntime>[0],
) {
  if (active) throw new Error('Renewal runtime already active')
  const handler = await createCredentialRenewalHttpRuntime(input)
  if (active) throw new Error('Renewal runtime already active')
  active = handler
}
export function credentialRenewalHttpRuntime() {
  return active
}
export function deactivateCredentialRenewalHttpRuntime() {
  active = undefined
}
