-- Pairing exists before farm selection. Never create a provisional enrollment.
CREATE TABLE farm.pairing_requests (
  agent_id uuid PRIMARY KEY,
  device_code_hash text UNIQUE NOT NULL CHECK (device_code_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text UNIQUE NOT NULL CHECK (user_code_hash ~ '^[a-f0-9]{64}$'),
  public_key_spki text NOT NULL CHECK (public_key_spki ~ '^[A-Za-z0-9_-]{59}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^SHA256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  platform text NOT NULL CHECK (platform IN ('linux', 'darwin', 'win32')),
  version text NOT NULL CHECK (length(version) BETWEEN 5 AND 64),
  issued_at bigint NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199253840991),
  expires_at bigint NOT NULL CHECK (expires_at = issued_at + 900000),
  next_poll_at bigint NOT NULL CHECK (next_poll_at BETWEEN issued_at AND 9007199254740991),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  farm_id uuid REFERENCES farm.farms(id),
  decided_by text REFERENCES farm.session_accounts(id),
  CHECK ((status IN ('approved', 'consumed') AND farm_id IS NOT NULL AND decided_by IS NOT NULL)
      OR (status IN ('pending', 'denied', 'expired') AND farm_id IS NULL AND decided_by IS NULL))
);
CREATE FUNCTION farm.pairing_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'Pairing tombstones must be retained'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.next_poll_at <> NEW.issued_at THEN
      RAISE EXCEPTION 'Pairing must start pending';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.agent_id, NEW.device_code_hash, NEW.user_code_hash, NEW.public_key_spki,
      NEW.fingerprint, NEW.platform, NEW.version, NEW.issued_at, NEW.expires_at)
    IS DISTINCT FROM
     (OLD.agent_id, OLD.device_code_hash, OLD.user_code_hash, OLD.public_key_spki,
      OLD.fingerprint, OLD.platform, OLD.version, OLD.issued_at, OLD.expires_at)
    OR NEW.next_poll_at < OLD.next_poll_at THEN
    RAISE EXCEPTION 'Pairing identity and clocks are immutable';
  END IF;
  IF OLD.status IN ('denied', 'expired', 'consumed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Pairing terminal state is immutable';
  END IF;
  IF OLD.status = 'approved' AND (NEW.status NOT IN ('approved', 'consumed')
    OR (NEW.farm_id, NEW.decided_by) IS DISTINCT FROM (OLD.farm_id, OLD.decided_by)) THEN
    RAISE EXCEPTION 'Pairing decision is immutable';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'consumed' THEN
    RAISE EXCEPTION 'Pairing requires approval before consumption';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pairing_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.pairing_requests
  FOR EACH ROW EXECUTE FUNCTION farm.pairing_lifecycle();
CREATE TRIGGER pairing_no_truncate BEFORE TRUNCATE ON farm.pairing_requests
  FOR EACH STATEMENT EXECUTE FUNCTION farm.pairing_lifecycle();
CREATE ROLE farm_pairing_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_pairing_runtime;
GRANT SELECT, INSERT ON farm.pairing_requests TO farm_pairing_runtime;
GRANT UPDATE (status, next_poll_at, farm_id, decided_by) ON farm.pairing_requests TO farm_pairing_runtime;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments TO farm_pairing_runtime;
GRANT UPDATE (id) ON farm.session_accounts TO farm_pairing_runtime;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_pairing_runtime;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_pairing_runtime;
GRANT INSERT (agent_id, farm_id, public_key_spki, fingerprint), UPDATE (status) ON farm.connector_enrollments TO farm_pairing_runtime;
