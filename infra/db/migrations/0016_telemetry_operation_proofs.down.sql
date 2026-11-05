-- Fail closed: never reinterpret an existing operation-bound generation as generic authority.
LOCK TABLE farm.connector_credential_proofs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM farm.connector_credential_proofs WHERE proof_version=2) THEN
    RAISE EXCEPTION 'Operation-bound proof records require explicit reviewed retirement before rollback';
  END IF;
END; $$;
REVOKE ALL ON farm.printer_assignments,farm.telemetry_events FROM farm_connector_telemetry_writer;
REVOKE UPDATE (id) ON farm.printer_assignments FROM farm_connector_telemetry_writer;
REVOKE UPDATE (event_id) ON farm.telemetry_events FROM farm_connector_telemetry_writer;
REVOKE farm_connector_credential_acceptor FROM farm_connector_telemetry_writer;
DROP ROLE farm_connector_telemetry_writer;
REVOKE UPDATE (proof_version,operation_method,operation_path,body_sha256,body_bytes) ON farm.connector_credential_proofs FROM farm_connector_credential_acceptor;
DROP TRIGGER connector_operation_proof_lifecycle ON farm.connector_credential_proofs;
DROP FUNCTION farm.connector_operation_proof_lifecycle();
ALTER TABLE farm.connector_credential_proofs DROP CONSTRAINT connector_operation_binding,
  DROP COLUMN proof_version,DROP COLUMN operation_method,DROP COLUMN operation_path,DROP COLUMN body_sha256,DROP COLUMN body_bytes;
