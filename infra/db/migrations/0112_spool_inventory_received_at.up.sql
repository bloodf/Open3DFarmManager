-- Existing snapshots have no trusted receive time until a new observation arrives.
ALTER TABLE farm.connector_inventory_snapshots ADD COLUMN received_at bigint;

-- Lock provenance without granting the integration role UPDATE on inventory or settings.
CREATE FUNCTION farm.lock_physical_spool_observations_with_receipt(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.agent_id, s.observed_at, s.snapshot, s.received_at
  FROM farm.connector_enrollments e
  JOIN farm.spoolman_connector_settings c USING (farm_id, agent_id)
  JOIN farm.connector_inventory_snapshots s USING (farm_id, agent_id)
  WHERE e.farm_id = p_farm_id AND e.status = 'approved'
    AND c.configured AND c.service_id = p_service_id
  ORDER BY e.agent_id
  FOR SHARE OF e, c, s
$$;
REVOKE ALL ON FUNCTION farm.lock_physical_spool_observations_with_receipt(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.lock_physical_spool_observations_with_receipt(uuid, uuid) TO farm_integration_apps;
