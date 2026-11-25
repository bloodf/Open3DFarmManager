-- Keep the current freshness entry points available; older wrappers are superseded.
REVOKE EXECUTE ON FUNCTION farm.lock_physical_spool_observations(uuid, uuid),
  farm.lock_physical_spool_observations_with_receipt(uuid, uuid),
  farm.read_physical_spool_observations_with_receipt(uuid, uuid)
  FROM farm_integration_apps;

ALTER TABLE farm.connector_inventory_snapshots
  ADD CONSTRAINT connector_inventory_snapshots_received_at_safe_integer
  CHECK (received_at BETWEEN 0 AND 9007199254740991);
