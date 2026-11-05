-- Metadata only. Compact JWTs and private signing keys never enter this table.
CREATE TABLE farm.connector_credentials (
  jti uuid PRIMARY KEY,
  agent_id uuid UNIQUE NOT NULL REFERENCES farm.pairing_requests(agent_id),
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  thumbprint text NOT NULL CHECK (thumbprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  kid text NOT NULL CHECK (kid ~ '^[A-Za-z0-9_-]{1,64}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 256),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 256),
  issued_at bigint NOT NULL CHECK (issued_at BETWEEN 0 AND 8640000000000),
  expires_at bigint NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + 3600 AND expires_at <= 8640000000000)
);
CREATE FUNCTION farm.connector_credential_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Credential metadata and tombstones are immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM farm.connector_enrollments e JOIN farm.pairing_requests p ON p.agent_id = e.agent_id
    WHERE e.agent_id = NEW.agent_id AND e.farm_id = NEW.farm_id AND e.fingerprint = NEW.fingerprint
      AND e.status = 'approved' AND p.status = 'approved' AND p.farm_id = NEW.farm_id
      AND p.fingerprint = NEW.fingerprint AND p.proof_expired_at IS NULL
  ) THEN RAISE EXCEPTION 'Credential metadata requires the approved pairing identity'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_credential_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.connector_credentials
  FOR EACH ROW EXECUTE FUNCTION farm.connector_credential_lifecycle();
CREATE TRIGGER connector_credential_no_truncate BEFORE TRUNCATE ON farm.connector_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION farm.connector_credential_lifecycle();
GRANT SELECT, INSERT ON farm.connector_credentials TO farm_pairing_runtime;
