-- Farm network view (#416). Expand-only: two new tables and grants.
-- Latest heartbeat per Connector: when it was last heard and the bounded health document.
CREATE TABLE farm.connector_heartbeats (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  agent_id uuid NOT NULL,
  last_seen_at bigint NOT NULL CHECK (last_seen_at BETWEEN 0 AND 9007199254740991),
  health jsonb NOT NULL CHECK (jsonb_typeof(health) = 'object' AND octet_length(health::text) <= 32768),
  PRIMARY KEY (farm_id, agent_id)
);

-- Latest discovery set per Connector. Each report replaces the previous set; at most 64 printers.
CREATE TABLE farm.connector_discoveries (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  agent_id uuid NOT NULL,
  observed_at bigint NOT NULL CHECK (observed_at BETWEEN 0 AND 9007199254740991),
  printers jsonb NOT NULL CHECK (jsonb_typeof(printers) = 'array' AND jsonb_array_length(printers) <= 64 AND octet_length(printers::text) <= 65536),
  PRIMARY KEY (farm_id, agent_id)
);

GRANT SELECT, INSERT, UPDATE ON farm.connector_heartbeats, farm.connector_discoveries TO farm_connector_telemetry_writer;
GRANT SELECT ON farm.connector_heartbeats, farm.connector_discoveries TO farm_printer_state_reader;
GRANT SELECT (farm_id, agent_id, fingerprint, status) ON farm.connector_enrollments TO farm_printer_state_reader;
GRANT SELECT, DELETE ON farm.connector_heartbeats, farm.connector_discoveries TO farm_telemetry_prune_owner;

-- Retention rides the existing telemetry prune (0036): same signature, same owner and privileges.
-- Heartbeat and discovery rows older than the telemetry window are removed and counted with telemetry.
CREATE OR REPLACE FUNCTION farm.prune_telemetry(telemetry_days integer, job_history_days integer, batch_size integer)
RETURNS TABLE (telemetry_deleted integer, jobs_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp
AS $$
DECLARE
  now_ms bigint := floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
  network_deleted integer;
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
    SELECT old.farm_id, old.agent_id
    FROM farm.connector_heartbeats old
    WHERE old.last_seen_at <= now_ms - telemetry_days::bigint * 86400000
    ORDER BY old.last_seen_at, old.farm_id, old.agent_id
    LIMIT batch_size
  )
  DELETE FROM farm.connector_heartbeats h USING candidates c
  WHERE h.farm_id = c.farm_id AND h.agent_id = c.agent_id;
  GET DIAGNOSTICS network_deleted = ROW_COUNT;
  telemetry_deleted := telemetry_deleted + network_deleted;

  WITH candidates AS MATERIALIZED (
    SELECT old.farm_id, old.agent_id
    FROM farm.connector_discoveries old
    WHERE old.observed_at <= now_ms - telemetry_days::bigint * 86400000
    ORDER BY old.observed_at, old.farm_id, old.agent_id
    LIMIT batch_size
  )
  DELETE FROM farm.connector_discoveries d USING candidates c
  WHERE d.farm_id = c.farm_id AND d.agent_id = c.agent_id;
  GET DIAGNOSTICS network_deleted = ROW_COUNT;
  telemetry_deleted := telemetry_deleted + network_deleted;

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
