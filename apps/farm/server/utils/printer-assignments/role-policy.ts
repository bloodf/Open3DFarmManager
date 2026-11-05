import type { Sql } from 'postgres'
/** Reject effective privileges outside 0015, including direct, PUBLIC and SET ROLE access. */
export async function validatePrinterAssignmentRole(sql: Sql): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT
      pg_has_role(current_user,'farm_printer_ownership','USAGE')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolcanlogin)
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR r.rolname NOT IN (current_user,'farm_printer_ownership')
          OR (r.rolname='farm_printer_ownership' AND r.rolcanlogin)))
      AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database()
        AND (pg_has_role(current_user,d.datdba,'MEMBER') OR has_database_privilege(current_user,d.oid,'CREATE')))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND (pg_has_role(current_user,n.nspowner,'MEMBER') OR has_schema_privilege(current_user,n.oid,'CREATE')))
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(current_user,c.relowner,'MEMBER')
          OR (has_table_privilege(current_user,c.oid,'SELECT') AND NOT (n.nspname='farm' AND c.relname IN ('session_accounts','account_sessions','memberships','connector_enrollments','printer_assignments')))
          OR (has_table_privilege(current_user,c.oid,'INSERT') AND NOT (n.nspname='farm' AND c.relname='printer_assignments'))
          OR has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f')
        AND ((has_column_privilege(current_user,c.oid,a.attnum,'SELECT') AND NOT (n.nspname='farm' AND c.relname IN ('session_accounts','account_sessions','memberships','connector_enrollments','printer_assignments')))
          OR (has_column_privilege(current_user,c.oid,a.attnum,'INSERT') AND NOT (n.nspname='farm' AND c.relname='printer_assignments'))
          OR has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES')
          OR (has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') AND NOT (n.nspname='farm' AND ((c.relname='session_accounts' AND a.attname='id') OR (c.relname='account_sessions' AND a.attname IN ('last_seen_at','revoked_at')) OR (c.relname='memberships' AND a.attname='farm_id') OR (c.relname='connector_enrollments' AND a.attname='agent_id') OR (c.relname='printer_assignments' AND a.attname IN ('revoked_at','revoked_by')))))))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind='S'
        AND (pg_has_role(current_user,c.relowner,'MEMBER') OR has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')))
      AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND has_function_privilege(current_user,p.oid,'EXECUTE') AND (p.prosecdef OR p.prorettype<>'trigger'::regtype))
      AND has_schema_privilege(current_user,'farm','USAGE')
      AND has_table_privilege(current_user,'farm.session_accounts','SELECT')
      AND has_table_privilege(current_user,'farm.account_sessions','SELECT')
      AND has_table_privilege(current_user,'farm.memberships','SELECT')
      AND has_table_privilege(current_user,'farm.connector_enrollments','SELECT')
      AND has_table_privilege(current_user,'farm.printer_assignments','SELECT')
      AND has_table_privilege(current_user,'farm.printer_assignments','INSERT')
      AND has_column_privilege(current_user,'farm.session_accounts','id','UPDATE')
      AND has_column_privilege(current_user,'farm.account_sessions','last_seen_at','UPDATE')
      AND has_column_privilege(current_user,'farm.account_sessions','revoked_at','UPDATE')
      AND has_column_privilege(current_user,'farm.memberships','farm_id','UPDATE')
      AND has_column_privilege(current_user,'farm.connector_enrollments','agent_id','UPDATE')
      AND has_column_privilege(current_user,'farm.printer_assignments','revoked_at','UPDATE')
      AND has_column_privilege(current_user,'farm.printer_assignments','revoked_by','UPDATE') AS allowed`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid printer assignment database role')
}
