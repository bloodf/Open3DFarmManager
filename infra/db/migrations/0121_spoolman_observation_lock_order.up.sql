CREATE FUNCTION farm.lock_spool_observation_provenance(p_farm_id uuid, p_service_id uuid, p_require_declared_service boolean)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint, age_at_send_ms bigint, revision bigint)
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  locked_agents uuid[];
BEGIN
  -- Snapshot writes acquire the snapshot row before their AFTER trigger can
  -- update settings. Take those locks first here too, in agent order.
  SELECT ARRAY(
    SELECT e.agent_id
    FROM farm.connector_enrollments e
    JOIN farm.connector_inventory_snapshots s USING (farm_id, agent_id)
    WHERE e.farm_id = p_farm_id AND e.status = 'approved'
    ORDER BY e.agent_id
    FOR SHARE OF e, s
  ) INTO locked_agents;

  PERFORM 1 FROM farm.spoolman_connector_settings c
  WHERE c.farm_id = p_farm_id AND c.agent_id = ANY (locked_agents)
  ORDER BY c.agent_id FOR SHARE;

  -- Use a fresh statement after waiting for settings, and only consider
  -- snapshots already locked above. A new snapshot may have arrived since.
  RETURN QUERY
  SELECT e.agent_id, s.observed_at, s.snapshot, s.received_at, s.age_at_send_ms, s.revision
  FROM farm.connector_enrollments e
  JOIN farm.connector_inventory_snapshots s
    ON s.farm_id = e.farm_id AND s.agent_id = e.agent_id
  LEFT JOIN farm.spoolman_connector_settings c
    ON c.farm_id = e.farm_id AND c.agent_id = e.agent_id
  WHERE e.farm_id = p_farm_id AND e.agent_id = ANY (locked_agents)
    AND e.status = 'approved'
    AND (c.agent_id IS NULL OR c.configured)
    AND CASE WHEN p_require_declared_service THEN c.service_id = p_service_id
      ELSE COALESCE(c.service_id::text, lower(s.snapshot->>'serviceId')) = p_service_id::text
    END
  ORDER BY e.agent_id;
END;
$$;

REVOKE ALL ON FUNCTION farm.lock_spool_observation_provenance(uuid, uuid, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations_with_freshness(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint, age_at_send_ms bigint, revision bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.agent_id, o.observed_at, o.snapshot, o.received_at, o.age_at_send_ms, o.revision
  FROM farm.lock_spool_observation_provenance(p_farm_id, p_service_id, false) o
  ORDER BY o.agent_id
$$;

-- Preserve the older entry points, including the original declared-ID filter.
CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations_with_receipt(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.agent_id, o.observed_at, o.snapshot, o.received_at
  FROM farm.lock_spool_observation_provenance(p_farm_id, p_service_id, false) o
  ORDER BY o.agent_id
$$;


CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.agent_id, o.observed_at, o.snapshot
  FROM farm.lock_spool_observation_provenance(p_farm_id, p_service_id, true) o
  ORDER BY o.agent_id
$$;
