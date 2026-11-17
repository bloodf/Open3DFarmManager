CREATE ROLE farm_telemetry_pruner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE farm_telemetry_prune_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_telemetry_pruner, farm_telemetry_prune_owner;
GRANT SELECT, DELETE ON farm.telemetry_events, farm.job_history TO farm_telemetry_prune_owner;

CREATE OR REPLACE FUNCTION farm.job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'farm_telemetry_prune_owner' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Job history rows are immutable';
END;
$$;

CREATE FUNCTION farm.prune_telemetry(telemetry_days integer, job_history_days integer, batch_size integer)
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
REVOKE ALL ON FUNCTION farm.prune_telemetry(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.prune_telemetry(integer, integer, integer) TO farm_telemetry_pruner;
GRANT CREATE ON SCHEMA farm TO farm_telemetry_prune_owner;
ALTER FUNCTION farm.prune_telemetry(integer, integer, integer) OWNER TO farm_telemetry_prune_owner;
REVOKE CREATE ON SCHEMA farm FROM farm_telemetry_prune_owner;
