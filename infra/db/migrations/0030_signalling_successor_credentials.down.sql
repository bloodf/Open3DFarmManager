-- Removes only the grants added by 0026. Proof rows written by signalling stay;
-- the telemetry writer keeps its own direct 0022 grants.
REVOKE UPDATE (observed_at,credential_expired_at,generation,status,nonce,connection_id,token_hash,origin,audience,purpose,issued_at,expires_at,next_attempt_at,failures,consumed_at,proof_version,operation_method,operation_path,body_sha256,body_bytes)
  ON farm.connector_successor_proofs FROM farm_connector_credential_acceptor;
REVOKE SELECT, INSERT ON farm.connector_successor_proofs FROM farm_connector_credential_acceptor;
REVOKE UPDATE (jti) ON farm.connector_credential_successors FROM farm_connector_credential_acceptor;
REVOKE SELECT ON farm.connector_credential_successors FROM farm_connector_credential_acceptor;
REVOKE SELECT ON farm.connector_credential_successors FROM farm_signalling_reader;
