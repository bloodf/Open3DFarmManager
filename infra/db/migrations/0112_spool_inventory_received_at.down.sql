DROP FUNCTION farm.lock_physical_spool_observations_with_receipt(uuid, uuid);
ALTER TABLE farm.connector_inventory_snapshots DROP COLUMN received_at;
