-- One reusable slot per issued credential; retained watermark and expiry are never reset.
CREATE TABLE farm.connector_credential_proofs (
  jti uuid PRIMARY KEY REFERENCES farm.connector_credentials(jti),
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
CREATE FUNCTION farm.connector_credential_proof_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Credential proof watermark must be retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.generation<>0 OR NEW.status<>'idle' THEN RAISE EXCEPTION 'Credential proof must start idle'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.jti<>OLD.jti OR NEW.observed_at<OLD.observed_at OR NEW.next_attempt_at<OLD.next_attempt_at
    OR (OLD.credential_expired_at IS NOT NULL AND NEW.credential_expired_at IS DISTINCT FROM OLD.credential_expired_at)
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
  THEN RAISE EXCEPTION 'Credential proof watermark is monotonic'; END IF;
  IF NEW.generation=OLD.generation THEN
    IF (NEW.nonce,NEW.connection_id,NEW.token_hash,NEW.origin,NEW.audience,NEW.purpose,NEW.issued_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.nonce,OLD.connection_id,OLD.token_hash,OLD.origin,OLD.audience,OLD.purpose,OLD.issued_at,OLD.expires_at)
      OR NEW.failures<OLD.failures OR (OLD.status<>'pending' AND (NEW.status,NEW.consumed_at,NEW.failures) IS DISTINCT FROM (OLD.status,OLD.consumed_at,OLD.failures))
    THEN RAISE EXCEPTION 'Challenge identity and terminal outcome are immutable'; END IF;
  ELSE
    IF NEW.status<>'pending' OR NEW.failures<>0 OR NEW.consumed_at IS NOT NULL OR NEW.credential_expired_at IS NOT NULL
      OR NEW.issued_at<OLD.observed_at OR (OLD.nonce IS NOT NULL AND NEW.nonce=OLD.nonce)
      OR (OLD.status='pending' AND OLD.expires_at>NEW.observed_at)
    THEN RAISE EXCEPTION 'Challenge replacement requires a terminal or expired slot'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_credential_proof_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.connector_credential_proofs FOR EACH ROW EXECUTE FUNCTION farm.connector_credential_proof_lifecycle();
CREATE TRIGGER connector_credential_proof_no_truncate BEFORE TRUNCATE ON farm.connector_credential_proofs FOR EACH STATEMENT EXECUTE FUNCTION farm.connector_credential_proof_lifecycle();
CREATE ROLE farm_connector_credential_acceptor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_connector_credential_acceptor;
GRANT SELECT ON farm.connector_enrollments,farm.connector_credentials,farm.connector_revocations,farm.connector_credential_proofs TO farm_connector_credential_acceptor;
GRANT UPDATE (agent_id) ON farm.connector_enrollments TO farm_connector_credential_acceptor;
GRANT UPDATE (jti) ON farm.connector_credentials TO farm_connector_credential_acceptor;
GRANT INSERT ON farm.connector_credential_proofs TO farm_connector_credential_acceptor;
GRANT UPDATE (observed_at,credential_expired_at,generation,status,nonce,connection_id,token_hash,origin,audience,purpose,issued_at,expires_at,next_attempt_at,failures,consumed_at) ON farm.connector_credential_proofs TO farm_connector_credential_acceptor;
