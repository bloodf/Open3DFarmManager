import type { Sql } from 'postgres'

const TABLES = [
  'spool_vendors',
  'spool_filaments',
  'spools',
  'spool_library_counters',
  'spool_library_credentials',
]
/**
 * Tables added by migration 0089 that the auxiliary Spoolman APIs write
 * (settings, extra-field definitions, locations). The login role holds them
 * through `farm_spool_features`, which it may also be a member of.
 */
const FEATURE_TABLES = [
  'spool_library_settings',
  'spool_library_fields',
  'spool_locations',
  'spool_drying_logs',
  'spool_humidity_readings',
  'spool_farm_settings',
  'spool_slot_assignments',
  'spool_usage_records',
]
const FEATURE_ROLE = 'farm_spool_features'
/** Migration 0113 identity map and move journal: INSERT only, never UPDATE. */
const MOVE_TABLES = ['spool_identities', 'spool_moves']

/** Tables where the role may hold UPDATE: the spool tables (column-level) and the session touch columns. */
const TABLES_WITH_UPDATE = [
  ...TABLES,
  ...FEATURE_TABLES,
  'session_accounts',
  'account_sessions',
  'memberships',
]

/**
 * Rejects effective privileges outside migration 0085: no elevated role
 * attributes, no extra memberships, and writes only to the spool library tables
 * (plus the session touch columns the authority check needs).
 */
export async function validateSpoolLibraryRole(sql: Sql): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT
      pg_has_role(current_user,'farm_spool_library','USAGE')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin)
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR r.rolname NOT IN (current_user,'farm_spool_library',${FEATURE_ROLE})
          OR (r.rolname IN ('farm_spool_library',${FEATURE_ROLE}) AND r.rolcanlogin)))
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(current_user,c.relowner,'MEMBER')
          OR has_table_privilege(current_user,c.oid,'TRUNCATE')
          OR has_table_privilege(current_user,c.oid,'REFERENCES')
          OR has_table_privilege(current_user,c.oid,'TRIGGER')
          OR ((has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'DELETE'))
              AND NOT (n.nspname='farm' AND c.relname = ANY(${[...TABLES, ...FEATURE_TABLES, ...MOVE_TABLES]}::text[])))
          OR (has_any_column_privilege(current_user,c.oid,'UPDATE')
              AND NOT (n.nspname='farm' AND c.relname = ANY(${TABLES_WITH_UPDATE}::text[])))
          OR has_table_privilege(current_user,c.oid,'UPDATE')))
      AND has_table_privilege(current_user,'farm.spools','SELECT')
      AND has_table_privilege(current_user,'farm.spools','INSERT')
      AND has_table_privilege(current_user,'farm.spools','DELETE')
      AND has_any_column_privilege(current_user,'farm.spools','UPDATE')
      AND has_table_privilege(current_user,'farm.spool_library_credentials','SELECT')
      AND has_table_privilege(current_user,'farm.spool_library_credentials','INSERT')
      AND NOT has_table_privilege(current_user,'farm.spool_library_credentials','DELETE')
      AND NOT has_column_privilege(current_user,'farm.spool_library_credentials','secret_sha256','UPDATE')
      AND NOT has_column_privilege(current_user,'farm.spools','farm_id','UPDATE')
      AND has_table_privilege(current_user,'farm.memberships','SELECT') AS allowed`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid spool library database role')
}
