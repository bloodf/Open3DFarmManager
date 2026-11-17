CREATE TABLE farm.printer_latest_state (
  farm_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  printer_key text COLLATE "C" NOT NULL CHECK (length(printer_key) BETWEEN 1 AND 128),
  observed_at bigint NOT NULL CHECK (observed_at BETWEEN 0 AND 9007199254740991),
  state jsonb NOT NULL,
  PRIMARY KEY (farm_id, agent_id, printer_key)
);
GRANT SELECT, INSERT, UPDATE ON farm.printer_latest_state TO farm_telemetry_writer, farm_connector_telemetry_writer;
CREATE ROLE farm_printer_latest_state_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_printer_latest_state_reader;
GRANT SELECT ON farm.printer_assignments, farm.printer_latest_state TO farm_printer_latest_state_reader;
