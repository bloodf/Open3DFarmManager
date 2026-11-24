-- Public service identity only; credentials remain private to the Connector.
ALTER TABLE farm.spoolman_connector_settings ADD COLUMN service_id uuid;
