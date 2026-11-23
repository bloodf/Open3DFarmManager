CREATE TABLE farm.connector_inventory_snapshots (
  farm_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  observed_at bigint NOT NULL CHECK (observed_at BETWEEN 0 AND 9007199254740991),
  snapshot jsonb NOT NULL CHECK (octet_length(snapshot::text) <= 8192),
  PRIMARY KEY (farm_id, agent_id)
);
GRANT SELECT, INSERT, UPDATE ON farm.connector_inventory_snapshots TO farm_connector_telemetry_writer;
