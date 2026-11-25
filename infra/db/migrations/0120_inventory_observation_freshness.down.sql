DROP TRIGGER connector_inventory_legacy_observation ON farm.connector_inventory_snapshots;
DROP FUNCTION farm.lock_physical_spool_observations_with_freshness(uuid, uuid);
DROP FUNCTION farm.read_physical_spool_observations_with_freshness(uuid, uuid);
ALTER TABLE farm.connector_inventory_snapshots DROP COLUMN age_at_send_ms, DROP COLUMN revision;
