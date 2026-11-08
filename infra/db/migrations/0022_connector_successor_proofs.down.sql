-- Operational rollback retains these proofs; physical down is empty-only.
LOCK TABLE farm.connector_successor_proofs IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.connector_successor_proofs) THEN
    RAISE EXCEPTION 'Cannot remove retained successor proofs';
  END IF;
END;
$$;
DROP TABLE farm.connector_successor_proofs;
DROP FUNCTION farm.connector_successor_proof_binding();
REVOKE SELECT ON farm.connector_credential_successors FROM farm_connector_telemetry_writer;
REVOKE UPDATE (jti) ON farm.connector_credential_successors FROM farm_connector_telemetry_writer;
