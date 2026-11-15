-- Refuse rollback while recorded jobs remain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.job_history) THEN
    RAISE EXCEPTION 'Recorded job history must be exported before rollback';
  END IF;
END;
$$;
REVOKE INSERT ON farm.job_history FROM farm_connector_telemetry_writer;
DROP TABLE farm.job_history;
DROP FUNCTION farm.job_history_immutable();
REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_job_history_reader;
REVOKE UPDATE (last_seen_at, revoked_at) ON farm.account_sessions FROM farm_job_history_reader;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_job_history_reader;
REVOKE SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships FROM farm_job_history_reader;
REVOKE USAGE ON SCHEMA farm FROM farm_job_history_reader;
DROP ROLE farm_job_history_reader;
