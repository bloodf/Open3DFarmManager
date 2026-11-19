CREATE OR REPLACE FUNCTION farm.prune_telemetry(telemetry_days integer, job_history_days integer, batch_size integer)
RETURNS TABLE (telemetry_deleted integer, jobs_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp
AS $$
DECLARE
  now_ms bigint := floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
BEGIN
  IF telemetry_days NOT BETWEEN 1 AND 3650 OR job_history_days NOT BETWEEN 1 AND 3650 OR batch_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid telemetry retention settings';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT old.ctid
    FROM farm.telemetry_events old
    WHERE old.payload->>'queuedAt' ~ '^[0-9]{1,16}$'
      AND (old.payload->>'queuedAt')::bigint <= now_ms - telemetry_days::bigint * 86400000
    ORDER BY (old.payload->>'queuedAt')::bigint, old.farm_id, old.agent_id, old.event_id
    LIMIT batch_size
  )
  DELETE FROM farm.telemetry_events e USING candidates
  WHERE e.ctid = candidates.ctid;
  GET DIAGNOSTICS telemetry_deleted = ROW_COUNT;

  WITH candidates AS MATERIALIZED (
    SELECT old.id
    FROM farm.job_history old
    WHERE old.ended_at <= now_ms - job_history_days::bigint * 86400000
    ORDER BY old.ended_at, old.id
    LIMIT batch_size
  )
  DELETE FROM farm.job_history j USING candidates
  WHERE j.id = candidates.id;
  GET DIAGNOSTICS jobs_deleted = ROW_COUNT;
  RETURN NEXT;
END;
$$;
REVOKE SELECT, DELETE ON farm.connector_heartbeats, farm.connector_discoveries FROM farm_telemetry_prune_owner;
REVOKE SELECT (farm_id, agent_id, fingerprint, status) ON farm.connector_enrollments FROM farm_printer_state_reader;
REVOKE SELECT ON farm.connector_heartbeats, farm.connector_discoveries FROM farm_printer_state_reader;
REVOKE SELECT, INSERT, UPDATE ON farm.connector_heartbeats, farm.connector_discoveries FROM farm_connector_telemetry_writer;
DROP TABLE farm.connector_discoveries;
DROP TABLE farm.connector_heartbeats;
