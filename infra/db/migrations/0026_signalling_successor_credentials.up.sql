-- Signalling adopts renewed (successor) Connector credentials. Each credential,
-- root or successor, stays valid until its own expiry; nothing here revokes a
-- predecessor. Successor rows and their binding stay immutable (0021 trigger).
--
-- The signalling reader resolves an exact successor identity. Rows are
-- immutable, so it reads without row locks and gets SELECT only.
GRANT SELECT ON farm.connector_credential_successors TO farm_signalling_reader;
-- The signalling acceptor issues and consumes proofs for a successor exactly as
-- the telemetry writer does (0022). UPDATE (jti) only serves FOR SHARE row
-- locks; the 0021 trigger rejects any update.
GRANT SELECT ON farm.connector_credential_successors TO farm_connector_credential_acceptor;
GRANT UPDATE (jti) ON farm.connector_credential_successors TO farm_connector_credential_acceptor;
GRANT SELECT, INSERT ON farm.connector_successor_proofs TO farm_connector_credential_acceptor;
GRANT UPDATE (observed_at,credential_expired_at,generation,status,nonce,connection_id,token_hash,origin,audience,purpose,issued_at,expires_at,next_attempt_at,failures,consumed_at,proof_version,operation_method,operation_path,body_sha256,body_bytes)
  ON farm.connector_successor_proofs TO farm_connector_credential_acceptor;
