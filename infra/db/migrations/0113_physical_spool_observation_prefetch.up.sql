-- Read candidate provenance without locking rows during Connector lookups.
CREATE FUNCTION farm.read_physical_spool_observations_with_receipt(p_farm_id uuid, p_service_id uuid)
RETURNS TABLE (agent_id uuid, observed_at bigint, snapshot jsonb, received_at bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.agent_id, s.observed_at, s.snapshot, s.received_at
  FROM farm.connector_enrollments e
  JOIN farm.spoolman_connector_settings c USING (farm_id, agent_id)
  JOIN farm.connector_inventory_snapshots s USING (farm_id, agent_id)
  WHERE e.farm_id = p_farm_id AND e.status = 'approved'
    AND c.configured AND c.service_id = p_service_id
  ORDER BY e.agent_id
$$;
REVOKE ALL ON FUNCTION farm.read_physical_spool_observations_with_receipt(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.read_physical_spool_observations_with_receipt(uuid, uuid) TO farm_integration_apps;
