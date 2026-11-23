import type { Sql } from 'postgres'

const WRITE_TABLES = [
  'spool_vendors',
  'spool_filaments',
  'spools',
  'spool_library_counters',
  'spool_import_runs',
  'spool_import_identities',
  'spool_library_fields',
  'spool_library_settings',
]
const UPDATE_TABLES = [
  ...WRITE_TABLES,
  'session_accounts',
  'account_sessions',
  'memberships',
]

/**
 * Rejects effective privileges outside migration 0086: no elevated role
 * attributes, no extra memberships, INSERT only on the library tables, column
 * UPDATE only where the import needs it, and no DELETE or TRUNCATE anywhere.
 */
export async function validateSpoolImportRole(sql: Sql): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT
      pg_has_role(current_user,'farm_spool_import','USAGE')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin)
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR r.rolname NOT IN (current_user,'farm_spool_import')
          OR (r.rolname='farm_spool_import' AND r.rolcanlogin)))
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(current_user,c.relowner,'MEMBER')
          OR has_table_privilege(current_user,c.oid,'DELETE')
          OR has_table_privilege(current_user,c.oid,'TRUNCATE')
          OR has_table_privilege(current_user,c.oid,'REFERENCES')
          OR has_table_privilege(current_user,c.oid,'TRIGGER')
          OR has_table_privilege(current_user,c.oid,'UPDATE')
          OR (has_table_privilege(current_user,c.oid,'INSERT')
              AND NOT (n.nspname='farm' AND c.relname = ANY(${WRITE_TABLES}::text[])))
          OR (has_any_column_privilege(current_user,c.oid,'UPDATE')
              AND NOT (n.nspname='farm' AND c.relname = ANY(${UPDATE_TABLES}::text[])))))
      AND has_table_privilege(current_user,'farm.spools','INSERT')
      AND has_table_privilege(current_user,'farm.spool_import_identities','INSERT')
      AND NOT has_column_privilege(current_user,'farm.spools','farm_id','UPDATE')
      AND NOT has_column_privilege(current_user,'farm.spool_import_identities','farm_id','UPDATE')
      AND has_table_privilege(current_user,'farm.memberships','SELECT') AS allowed`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid spool import database role')
}
