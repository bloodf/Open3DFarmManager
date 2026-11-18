-- Read-only integration list endpoints. Existing grant filters remain the row boundary.
GRANT SELECT ON farm.job_history, farm.connector_inventory_snapshots TO farm_integration_apps;
