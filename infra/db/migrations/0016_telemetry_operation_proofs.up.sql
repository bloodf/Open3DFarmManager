ALTER TABLE farm.connector_credential_proofs
  ADD COLUMN proof_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN operation_method text,
  ADD COLUMN operation_path text,
  ADD COLUMN body_sha256 text,
  ADD COLUMN body_bytes integer,
  ADD CONSTRAINT connector_operation_binding CHECK (
    (proof_version=1 AND operation_method IS NULL AND operation_path IS NULL AND body_sha256 IS NULL AND body_bytes IS NULL)
    OR (proof_version=2 AND generation>0 AND purpose='telemetry-ingestion' AND operation_method IS NOT NULL AND operation_method='POST'
      AND operation_path IS NOT NULL AND operation_path='/api/connector/telemetry' AND body_sha256 IS NOT NULL AND body_sha256 ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
      AND body_bytes IS NOT NULL AND body_bytes BETWEEN 1 AND 65536)
  );
CREATE ROLE farm_connector_telemetry_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_acceptor;
CREATE FUNCTION farm.connector_operation_proof_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.proof_version<>1 THEN RAISE EXCEPTION 'Proof slots must start generic and idle'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.generation=OLD.generation AND (NEW.proof_version,NEW.operation_method,NEW.operation_path,NEW.body_sha256,NEW.body_bytes)
      IS DISTINCT FROM (OLD.proof_version,OLD.operation_method,OLD.operation_path,OLD.body_sha256,OLD.body_bytes)
    THEN RAISE EXCEPTION 'Operation binding is immutable within a generation'; END IF;
    IF NEW.generation<>OLD.generation AND NEW.proof_version=2 AND NOT pg_has_role(current_user,'farm_connector_telemetry_writer','USAGE')
    THEN RAISE EXCEPTION 'Operation-bound issuance requires telemetry capability'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_operation_proof_lifecycle BEFORE INSERT OR UPDATE ON farm.connector_credential_proofs FOR EACH ROW EXECUTE FUNCTION farm.connector_operation_proof_lifecycle();
-- Generic issuance can reset a legitimately replaced slot to v1, but the trigger denies v2 issuance.
GRANT UPDATE (proof_version,operation_method,operation_path,body_sha256,body_bytes) ON farm.connector_credential_proofs TO farm_connector_credential_acceptor;
GRANT SELECT ON farm.printer_assignments,farm.telemetry_events TO farm_connector_telemetry_writer;
-- Lock-only grants: existing lifecycle triggers reject all actual identity/event updates.
GRANT UPDATE (id) ON farm.printer_assignments TO farm_connector_telemetry_writer;
GRANT SELECT,INSERT ON farm.telemetry_events TO farm_connector_telemetry_writer;
GRANT UPDATE (event_id) ON farm.telemetry_events TO farm_connector_telemetry_writer;
