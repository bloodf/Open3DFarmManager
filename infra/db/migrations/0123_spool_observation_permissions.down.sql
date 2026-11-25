ALTER TABLE farm.connector_inventory_snapshots
  DROP CONSTRAINT connector_inventory_snapshots_received_at_safe_integer;

GRANT EXECUTE ON FUNCTION farm.lock_physical_spool_observations(uuid, uuid),
  farm.lock_physical_spool_observations_with_receipt(uuid, uuid),
  farm.read_physical_spool_observations_with_receipt(uuid, uuid)
  TO farm_integration_apps;
