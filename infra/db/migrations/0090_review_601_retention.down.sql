CREATE OR REPLACE FUNCTION farm.prune_integration_audit(retain_after bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE removed bigint;
BEGIN
  PERFORM set_config('farm.audit_pruning', 'on', true);
  DELETE FROM farm.integration_audit WHERE occurred_at < retain_after;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
CREATE OR REPLACE FUNCTION farm.integration_audit_prune_after_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  PERFORM farm.prune_integration_audit(NEW.occurred_at - 7776000000);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION farm.prune_telemetry(telemetry_days integer, job_history_days integer, batch_size integer)
RETURNS TABLE (telemetry_deleted integer, jobs_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  now_ms bigint := floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
BEGIN
  IF telemetry_days NOT BETWEEN 1 AND 3650 OR job_history_days NOT BETWEEN 1 AND 3650 OR batch_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid telemetry retention settings';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT old.ctid FROM farm.telemetry_events old
    WHERE old.payload->>'queuedAt' ~ '^[0-9]{1,16}$'
      AND (old.payload->>'queuedAt')::bigint <= now_ms - telemetry_days::bigint * 86400000
    ORDER BY (old.payload->>'queuedAt')::bigint, old.farm_id, old.agent_id, old.event_id LIMIT batch_size
  )
  DELETE FROM farm.telemetry_events e USING candidates WHERE e.ctid = candidates.ctid;
  GET DIAGNOSTICS telemetry_deleted = ROW_COUNT;
  WITH candidates AS MATERIALIZED (
    SELECT old.farm_id, old.agent_id FROM farm.connector_heartbeats old
    WHERE old.last_seen_at <= now_ms - telemetry_days::bigint * 86400000
    ORDER BY old.last_seen_at, old.farm_id, old.agent_id LIMIT batch_size
  )
  DELETE FROM farm.connector_heartbeats h USING candidates c WHERE h.farm_id = c.farm_id AND h.agent_id = c.agent_id;
  GET DIAGNOSTICS network_deleted = ROW_COUNT;
  telemetry_deleted := telemetry_deleted + network_deleted;
  WITH candidates AS MATERIALIZED (
    SELECT old.farm_id, old.agent_id FROM farm.connector_discoveries old
    WHERE old.observed_at <= now_ms - telemetry_days::bigint * 86400000
    ORDER BY old.observed_at, old.farm_id, old.agent_id LIMIT batch_size
  )
  DELETE FROM farm.connector_discoveries d USING candidates c WHERE d.farm_id = c.farm_id AND d.agent_id = c.agent_id;
  GET DIAGNOSTICS network_deleted = ROW_COUNT;
  telemetry_deleted := telemetry_deleted + network_deleted;
  WITH candidates AS MATERIALIZED (
    SELECT old.id FROM farm.job_history old
    WHERE old.ended_at <= now_ms - job_history_days::bigint * 86400000
    ORDER BY old.ended_at, old.id LIMIT batch_size
  )
  DELETE FROM farm.job_history j USING candidates WHERE j.id = candidates.id;
  GET DIAGNOSTICS jobs_deleted = ROW_COUNT;
  RETURN NEXT;
END;
$$;
