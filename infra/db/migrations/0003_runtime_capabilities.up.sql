-- Explicit draft capabilities in this product's dedicated cluster. No login credentials.
CREATE ROLE farm_enrollment_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE farm_telemetry_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE FUNCTION farm.telemetry_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Telemetry events cannot be updated';
END;
$$;
CREATE TRIGGER telemetry_no_update BEFORE UPDATE ON farm.telemetry_events
  FOR EACH ROW EXECUTE FUNCTION farm.telemetry_no_update();
GRANT USAGE ON SCHEMA farm TO farm_enrollment_reader, farm_telemetry_writer;
GRANT SELECT ON farm.connector_enrollments TO farm_enrollment_reader;
-- FOR SHARE requires UPDATE on at least one column. The lifecycle trigger rejects ID changes.
GRANT UPDATE (agent_id) ON farm.connector_enrollments TO farm_enrollment_reader;
GRANT SELECT, INSERT ON farm.telemetry_events TO farm_telemetry_writer;
-- Row locking is permitted, but the trigger rejects every actual UPDATE.
GRANT UPDATE (event_id) ON farm.telemetry_events TO farm_telemetry_writer;
