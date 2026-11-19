import type { Sql } from 'postgres'
/**
 * Rejects effective privileges outside migration 0052: no elevated role
 * attributes, no extra memberships, and writes only where the setting needs them.
 */
export async function validateSpoolmanSettingsRole(sql: Sql): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT
      pg_has_role(current_user,'farm_spoolman_settings','USAGE')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin)
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR r.rolname NOT IN (current_user,'farm_spoolman_settings')
          OR (r.rolname='farm_spoolman_settings' AND r.rolcanlogin)))
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(current_user,c.relowner,'MEMBER')
          OR (has_table_privilege(current_user,c.oid,'INSERT') AND NOT (n.nspname='farm' AND c.relname='spoolman_connector_settings'))
          OR (has_table_privilege(current_user,c.oid,'UPDATE') AND NOT (n.nspname='farm' AND c.relname='spoolman_connector_settings'))
          OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      AND has_table_privilege(current_user,'farm.spoolman_connector_settings','SELECT')
      AND has_table_privilege(current_user,'farm.spoolman_connector_settings','INSERT')
      AND has_table_privilege(current_user,'farm.memberships','SELECT')
      AND has_table_privilege(current_user,'farm.connector_enrollments','SELECT') AS allowed`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid Spoolman settings database role')
}
