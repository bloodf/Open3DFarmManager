DROP TRIGGER connector_inventory_observed_spoolman_service_id ON farm.connector_inventory_snapshots;
DROP FUNCTION farm.record_observed_spoolman_service_id();

-- Lock provenance without granting the integration role UPDATE on inventory or settings.
CREATE OR REPLACE FUNCTION farm.lock_physical_spool_observations_with_receipt(p_farm_id uuid, p_service_id uuid)
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

-- Read candidate provenance without locking rows during Connector lookups.
CREATE OR REPLACE FUNCTION farm.read_physical_spool_observations_with_receipt(p_farm_id uuid, p_service_id uuid)
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

ALTER TABLE farm.spoolman_connector_settings DROP COLUMN observed_service_id;
