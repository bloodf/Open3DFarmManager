-- Settings rows are locked first: FOR SHARE cannot cover the nullable side of
-- the outer join, and a Connector may have no settings row at all.
CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations_with_receipt(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM farm.spoolman_connector_settings c
  WHERE c.farm_id = p_farm_id ORDER BY c.agent_id FOR SHARE;
  -- A new statement, so a settings change waited on above is visible here.
  RETURN QUERY
  SELECT e.agent_id, s.observed_at, s.snapshot, s.received_at
  FROM farm.connector_enrollments e
  JOIN farm.connector_inventory_snapshots s
    ON s.farm_id = e.farm_id AND s.agent_id = e.agent_id
  LEFT JOIN farm.spoolman_connector_settings c
    ON c.farm_id = e.farm_id AND c.agent_id = e.agent_id
  WHERE e.farm_id = p_farm_id AND e.status = 'approved'
    AND (c.agent_id IS NULL OR c.configured)
    AND COALESCE(c.service_id::text, lower(s.snapshot->>'serviceId')) = p_service_id::text
  ORDER BY e.agent_id
  FOR SHARE OF e, s;
END;
$$;

-- Settings rows are locked first: FOR SHARE cannot cover the nullable side of
-- the outer join, and a Connector may have no settings row at all.
CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations_with_freshness(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint, age_at_send_ms bigint, revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM farm.spoolman_connector_settings c
  WHERE c.farm_id = p_farm_id ORDER BY c.agent_id FOR SHARE;
  -- A new statement, so a settings change waited on above is visible here.
  RETURN QUERY
  SELECT e.agent_id, s.observed_at, s.snapshot, s.received_at, s.age_at_send_ms, s.revision
  FROM farm.connector_enrollments e
  JOIN farm.connector_inventory_snapshots s
    ON s.farm_id = e.farm_id AND s.agent_id = e.agent_id
  LEFT JOIN farm.spoolman_connector_settings c
    ON c.farm_id = e.farm_id AND c.agent_id = e.agent_id
  WHERE e.farm_id = p_farm_id AND e.status = 'approved'
    AND (c.agent_id IS NULL OR c.configured)
    AND COALESCE(c.service_id::text, lower(s.snapshot->>'serviceId')) = p_service_id::text
  ORDER BY e.agent_id
  FOR SHARE OF e, s;
END;
$$;

-- Lock provenance without granting the integration role UPDATE on inventory or settings.
CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.agent_id, s.observed_at, s.snapshot
  FROM farm.connector_enrollments e
  JOIN farm.spoolman_connector_settings c USING (farm_id, agent_id)
  JOIN farm.connector_inventory_snapshots s USING (farm_id, agent_id)
  WHERE e.farm_id = p_farm_id AND e.status = 'approved'
    AND c.configured AND c.service_id = p_service_id
  ORDER BY e.agent_id
  FOR SHARE OF e, c, s
$$;

DROP FUNCTION farm.lock_spool_observation_provenance(uuid, uuid, boolean);
