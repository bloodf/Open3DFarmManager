-- Separate terminal metadata preserves immutable issuance records, including lost responses.
CREATE TABLE farm.connector_revocations (
  agent_id uuid PRIMARY KEY REFERENCES farm.connector_enrollments(agent_id),
  farm_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  credential_jti uuid UNIQUE REFERENCES farm.connector_credentials(jti),
  revoked_at bigint NOT NULL CHECK (revoked_at BETWEEN 0 AND 9007199254740991),
  revoked_by text NOT NULL REFERENCES farm.session_accounts(id)
);
CREATE FUNCTION farm.connector_revocation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issued_jti uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Connector revocations are immutable tombstones'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM farm.connector_enrollments
    WHERE agent_id = NEW.agent_id AND farm_id = NEW.farm_id AND fingerprint = NEW.fingerprint AND status = 'revoked'
  ) THEN RAISE EXCEPTION 'Revocation requires the exact revoked enrollment'; END IF;
  SELECT jti INTO issued_jti FROM farm.connector_credentials
    WHERE agent_id = NEW.agent_id AND farm_id = NEW.farm_id AND fingerprint = NEW.fingerprint;
  IF NEW.credential_jti IS DISTINCT FROM issued_jti
    OR EXISTS (SELECT 1 FROM farm.connector_credentials WHERE agent_id = NEW.agent_id AND (farm_id <> NEW.farm_id OR fingerprint <> NEW.fingerprint))
  THEN RAISE EXCEPTION 'Revocation must bind the exact issued credential or record its absence'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_revocation_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.connector_revocations
  FOR EACH ROW EXECUTE FUNCTION farm.connector_revocation_lifecycle();
CREATE TRIGGER connector_revocation_no_truncate BEFORE TRUNCATE ON farm.connector_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION farm.connector_revocation_lifecycle();
CREATE ROLE farm_connector_revoker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_connector_revoker;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships,
  farm.pairing_requests, farm.connector_enrollments, farm.connector_credentials, farm.connector_revocations TO farm_connector_revoker;
GRANT UPDATE (id) ON farm.session_accounts TO farm_connector_revoker;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_connector_revoker;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_connector_revoker;
GRANT UPDATE (agent_id) ON farm.pairing_requests TO farm_connector_revoker;
GRANT UPDATE (status) ON farm.connector_enrollments TO farm_connector_revoker;
-- Row locking only; the immutable issuance trigger rejects even a no-op UPDATE.
GRANT UPDATE (jti) ON farm.connector_credentials TO farm_connector_revoker;
GRANT INSERT ON farm.connector_revocations TO farm_connector_revoker;
