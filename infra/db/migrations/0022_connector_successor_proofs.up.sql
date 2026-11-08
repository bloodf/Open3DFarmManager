-- Additive telemetry proof storage; existing root proof rows and bytes remain unchanged.
CREATE TABLE farm.connector_successor_proofs (
  jti uuid PRIMARY KEY REFERENCES farm.connector_credential_successors(jti),
  root_jti uuid NOT NULL REFERENCES farm.connector_credentials(jti),
  observed_at bigint NOT NULL CHECK (observed_at BETWEEN 0 AND 9007199254740991),
  credential_expired_at bigint CHECK (credential_expired_at BETWEEN 0 AND observed_at),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','pending','consumed','expired','rejected')),
  nonce text CHECK (nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  connection_id uuid,
  token_hash text CHECK (token_hash ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  origin text CHECK (length(origin) BETWEEN 1 AND 256),
  audience text CHECK (length(audience) BETWEEN 1 AND 256),
  purpose text CHECK (purpose IN ('signalling','telemetry-ingestion')),
  issued_at bigint,
  expires_at bigint,
  next_attempt_at bigint NOT NULL CHECK (next_attempt_at BETWEEN 0 AND 9007199254740991),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 3),
  consumed_at bigint,
  CHECK ((generation=0 AND status='idle' AND nonce IS NULL AND connection_id IS NULL AND token_hash IS NULL AND origin IS NULL AND audience IS NULL AND purpose IS NULL AND issued_at IS NULL AND expires_at IS NULL AND consumed_at IS NULL AND failures=0)
    OR (generation>0 AND status<>'idle' AND nonce IS NOT NULL AND connection_id IS NOT NULL AND token_hash IS NOT NULL AND origin IS NOT NULL AND audience IS NOT NULL AND purpose IS NOT NULL AND issued_at IS NOT NULL AND expires_at IS NOT NULL AND issued_at BETWEEN 0 AND observed_at AND expires_at>issued_at AND expires_at<=issued_at+60000 AND expires_at<=9007199254740991 AND ((status='pending' AND consumed_at IS NULL) OR (status<>'pending' AND consumed_at IS NOT NULL AND consumed_at BETWEEN issued_at AND observed_at)))),
  CHECK (status<>'consumed' OR consumed_at<expires_at)
);
ALTER TABLE farm.connector_successor_proofs
  ADD COLUMN proof_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN operation_method text,
  ADD COLUMN operation_path text,
  ADD COLUMN body_sha256 text,
  ADD COLUMN body_bytes integer,
  ADD CONSTRAINT connector_successor_operation_binding CHECK (
    (proof_version=1 AND operation_method IS NULL AND operation_path IS NULL AND body_sha256 IS NULL AND body_bytes IS NULL)
    OR (proof_version=2 AND generation>0 AND purpose='telemetry-ingestion' AND operation_method IS NOT NULL AND operation_method='POST'
      AND operation_path IS NOT NULL AND operation_path='/api/connector/telemetry' AND body_sha256 IS NOT NULL AND body_sha256 ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
      AND body_bytes IS NOT NULL AND body_bytes BETWEEN 1 AND 65536)
  );
REVOKE ALL ON farm.connector_successor_proofs FROM PUBLIC;
CREATE FUNCTION farm.connector_successor_proof_binding() RETURNS pg_catalog.trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,farm,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM farm.connector_credential_successors s
      WHERE s.jti=NEW.jti AND s.root_jti=NEW.root_jti)
    THEN RAISE EXCEPTION 'Successor proof requires the exact root binding'; END IF;
  ELSIF NEW.root_jti IS DISTINCT FROM OLD.root_jti THEN
    RAISE EXCEPTION 'Successor proof root binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_successor_proof_binding BEFORE INSERT OR UPDATE ON farm.connector_successor_proofs
  FOR EACH ROW EXECUTE FUNCTION farm.connector_successor_proof_binding();
CREATE TRIGGER connector_successor_proof_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.connector_successor_proofs
  FOR EACH ROW EXECUTE FUNCTION farm.connector_credential_proof_lifecycle();
CREATE TRIGGER connector_successor_proof_no_truncate BEFORE TRUNCATE ON farm.connector_successor_proofs
  FOR EACH STATEMENT EXECUTE FUNCTION farm.connector_credential_proof_lifecycle();
CREATE TRIGGER connector_successor_operation_proof_lifecycle BEFORE INSERT OR UPDATE ON farm.connector_successor_proofs
  FOR EACH ROW EXECUTE FUNCTION farm.connector_operation_proof_lifecycle();
-- Only the existing telemetry consumer adopts successors. Row-lock privilege
-- cannot mutate immutable A2 metadata; no successor issuance grant is added.
GRANT SELECT ON farm.connector_credential_successors TO farm_connector_telemetry_writer;
GRANT UPDATE (jti) ON farm.connector_credential_successors TO farm_connector_telemetry_writer;
GRANT SELECT, INSERT ON farm.connector_successor_proofs TO farm_connector_telemetry_writer;
GRANT UPDATE (observed_at,credential_expired_at,generation,status,nonce,connection_id,token_hash,origin,audience,purpose,issued_at,expires_at,next_attempt_at,failures,consumed_at,proof_version,operation_method,operation_path,body_sha256,body_bytes)
  ON farm.connector_successor_proofs TO farm_connector_telemetry_writer;
