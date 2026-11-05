import type { Sql } from 'postgres'

/** Validate both the effective 0018 role and everything the login can SET ROLE into. */
export async function validatePauseAuthorityRole(sql: Sql): Promise<void> {
  const rows = await sql<{ allowed: boolean }[]>`
    WITH readable(name) AS (VALUES
      ('session_accounts'),('account_sessions'),('memberships'),('browser_device_keys'),
      ('connector_enrollments'),('connector_credentials'),('connector_revocations'),
      ('connector_credential_proofs'),('printer_assignments'),('pause_authority_watermark'),
      ('pause_authority_sessions'),('pause_authority_challenges')),
    insertable(name) AS (VALUES ('pause_authority_sessions'),('pause_authority_challenges')),
    updatable(name,col) AS (VALUES
      ('memberships','farm_id'),('browser_device_keys','key_id'),('connector_enrollments','agent_id'),
      ('connector_credentials','jti'),('connector_credential_proofs','jti'),('printer_assignments','id'),
      ('pause_authority_watermark','observed_at'),('pause_authority_sessions','window_started_at'),
      ('pause_authority_sessions','attempts'),('pause_authority_challenges','status'),
      ('pause_authority_challenges','consumed_at'),('pause_authority_challenges','capability_id'),
      ('pause_authority_challenges','capability'),('pause_authority_challenges','capability_hash'),
      ('pause_authority_challenges','capability_expires_at'),('pause_authority_challenges','retain_until')),
    principals(name) AS (VALUES (current_user::text),(session_user::text))
    SELECT current_user='farm_pause_authority'
      AND session_user<>current_user
      AND current_setting('statement_timeout')='2s'
      AND current_setting('lock_timeout')='1s'
      AND current_setting('transaction_timeout')='10s'
      AND current_setting('search_path')='pg_catalog'
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolcanlogin)
      AND pg_has_role(session_user,'farm_pause_authority','MEMBER')
      AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(session_user,r.oid,'MEMBER')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR r.rolname NOT IN (session_user,'farm_pause_authority')
          OR (r.rolname='farm_pause_authority' AND r.rolcanlogin)))
      AND NOT EXISTS (SELECT 1 FROM principals who CROSS JOIN pg_database d
        WHERE d.datname=current_database() AND
        (pg_has_role(who.name,d.datdba,'MEMBER') OR has_database_privilege(who.name,d.oid,'CREATE')))
      AND NOT EXISTS (SELECT 1 FROM principals who CROSS JOIN pg_namespace n
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND (pg_has_role(who.name,n.nspowner,'MEMBER') OR has_schema_privilege(who.name,n.oid,'CREATE')))
      AND NOT EXISTS (SELECT 1 FROM principals who CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(who.name,c.relowner,'MEMBER')
          OR (has_table_privilege(who.name,c.oid,'SELECT') AND NOT (n.nspname='farm' AND c.relname IN (SELECT name FROM readable)))
          OR (has_table_privilege(who.name,c.oid,'INSERT') AND NOT (n.nspname='farm' AND c.relname IN (SELECT name FROM insertable)))
          OR has_table_privilege(who.name,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      AND NOT EXISTS (SELECT 1 FROM principals who CROSS JOIN pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        AND ((has_column_privilege(who.name,c.oid,a.attnum,'SELECT') AND NOT (n.nspname='farm' AND c.relname IN (SELECT name FROM readable)))
          OR (has_column_privilege(who.name,c.oid,a.attnum,'INSERT') AND NOT (n.nspname='farm' AND c.relname IN (SELECT name FROM insertable)))
          OR has_column_privilege(who.name,c.oid,a.attnum,'REFERENCES')
          OR (has_column_privilege(who.name,c.oid,a.attnum,'UPDATE') AND NOT
            (n.nspname='farm' AND EXISTS (SELECT 1 FROM updatable u WHERE u.name=c.relname AND u.col=a.attname)))))
      AND NOT EXISTS (SELECT 1 FROM principals who CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind='S'
        AND (pg_has_role(who.name,c.relowner,'MEMBER') OR has_sequence_privilege(who.name,c.oid,'USAGE,SELECT,UPDATE')))
      AND NOT EXISTS (SELECT 1 FROM principals who CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
        AND has_function_privilege(who.name,p.oid,'EXECUTE') AND (p.prosecdef OR p.prorettype<>'trigger'::regtype)
        AND p.oid NOT IN ('farm.observe_signalling_session_expiry(text)'::regprocedure,'farm.prune_pause_authority()'::regprocedure))
      AND has_schema_privilege(current_user,'farm','USAGE')
      AND (SELECT bool_and(has_table_privilege(current_user,('farm.'||name)::regclass,'SELECT')) FROM readable)
      AND (SELECT bool_and(has_table_privilege(current_user,('farm.'||name)::regclass,'INSERT')) FROM insertable)
      AND (SELECT bool_and(has_column_privilege(current_user,('farm.'||name)::regclass,col,'UPDATE')) FROM updatable)
      AND has_function_privilege(current_user,'farm.observe_signalling_session_expiry(text)','EXECUTE')
      AND has_function_privilege(current_user,'farm.prune_pause_authority()','EXECUTE') AS allowed`
  if (rows.length !== 1 || rows[0]?.allowed !== true)
    throw new Error('Invalid pause authority database role')
}
