-- Finished jobs recorded from telemetry snapshots (expand-only). One row per printer and end time.
CREATE TABLE farm.job_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  agent_id uuid NOT NULL,
  printer_key text NOT NULL CHECK (char_length(printer_key) BETWEEN 1 AND 128),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'cancelled', 'failed')),
  filename text CHECK (filename IS NULL OR char_length(filename) <= 255),
  print_duration_seconds double precision CHECK (print_duration_seconds IS NULL OR print_duration_seconds >= 0),
  total_duration_seconds double precision CHECK (total_duration_seconds IS NULL OR total_duration_seconds >= 0),
  ended_at bigint NOT NULL CHECK (ended_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (farm_id, agent_id, printer_key, ended_at)
);
CREATE INDEX job_history_farm_recent ON farm.job_history (farm_id, ended_at DESC, id DESC);
-- Immutable once recorded; the first observation of an end time wins.
CREATE FUNCTION farm.job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job history rows are immutable';
END;
$$;
CREATE TRIGGER job_history_immutable BEFORE UPDATE OR DELETE ON farm.job_history FOR EACH ROW EXECUTE FUNCTION farm.job_history_immutable();
-- Telemetry ingestion records jobs in the same transaction as the event.
GRANT INSERT ON farm.job_history TO farm_connector_telemetry_writer;
-- Read-only role for the Histórico page: session and membership checks mirror printer inventory.
CREATE ROLE farm_job_history_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_job_history_reader;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.job_history TO farm_job_history_reader;
GRANT UPDATE (id) ON farm.session_accounts TO farm_job_history_reader;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_job_history_reader;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_job_history_reader;
