import type { Sql } from 'postgres'

/** Least-privilege roles the usage login may combine (migrations 0032, 0048, 0085, 0089). */
export const SPOOL_USAGE_ROLES = [
  'farm_spool_features',
  'farm_spool_library',
  'farm_job_history_reader',
  'farm_integration_apps',
]

/**
 * Usage recording needs three things no single spool role holds: insert usage
 * records (farm_spool_features), move spools.used_weight (farm_spool_library),
 * and read finished jobs / queue webhooks (farm_job_history_reader,
 * farm_integration_apps). The login must be a member of exactly those, with no
 * elevated attributes, no ownership and no TRUNCATE, REFERENCES or TRIGGER.
 */
export async function validateSpoolUsageRole(sql: Sql): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin)
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR (r.rolname<>current_user AND NOT (r.rolname = ANY(${SPOOL_USAGE_ROLES}::text[])))))
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(current_user,c.relowner,'MEMBER')
          OR has_table_privilege(current_user,c.oid,'TRUNCATE')
          OR has_table_privilege(current_user,c.oid,'REFERENCES')
          OR has_table_privilege(current_user,c.oid,'TRIGGER')))
      AND has_table_privilege(current_user,'farm.spool_usage_records','INSERT')
      AND has_column_privilege(current_user,'farm.spool_usage_records','grams','UPDATE')
      AND has_column_privilege(current_user,'farm.spools','used_weight','UPDATE')
      AND has_table_privilege(current_user,'farm.job_history','SELECT')
      AND has_table_privilege(current_user,'farm.spool_slot_assignments','SELECT')
      AND has_table_privilege(current_user,'farm.integration_webhook_outbox','INSERT')
      AND NOT has_column_privilege(current_user,'farm.spools','farm_id','UPDATE')
      AND NOT has_table_privilege(current_user,'farm.job_history','INSERT')
      AND has_table_privilege(current_user,'farm.memberships','SELECT') AS allowed`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid spool usage database role')
}
