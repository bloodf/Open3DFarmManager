-- Internal registry only. Account/session identifiers remain text, without UUID coercion.
CREATE TABLE farm.browser_device_keys (
  key_id uuid PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  account_id text NOT NULL REFERENCES farm.session_accounts(id),
  public_key jsonb NOT NULL CHECK (jsonb_typeof(public_key) = 'object' AND public_key ?& ARRAY['kty','crv','x','y'] AND jsonb_typeof(public_key->'kty') = 'string' AND jsonb_typeof(public_key->'crv') = 'string' AND jsonb_typeof(public_key->'x') = 'string' AND jsonb_typeof(public_key->'y') = 'string' AND public_key->>'kty' = 'EC' AND public_key->>'crv' = 'P-256' AND public_key->>'x' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' AND public_key->>'y' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' AND public_key - ARRAY['kty','crv','x','y'] = '{}'::jsonb),
  thumbprint text NOT NULL CHECK (thumbprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254680991),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked')),
  proof_at bigint CHECK (proof_at BETWEEN created_at AND 9007199254740991),
  proof_session_id text REFERENCES farm.account_sessions(id),
  approved_at bigint CHECK (approved_at BETWEEN created_at AND 9007199254740991),
  approved_by text REFERENCES farm.session_accounts(id),
  revoked_at bigint CHECK (revoked_at BETWEEN created_at AND 9007199254740991),
  revoked_by text REFERENCES farm.session_accounts(id),
  UNIQUE(farm_id, account_id, thumbprint),
  CHECK ((proof_at IS NULL) = (proof_session_id IS NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK (status <> 'pending' OR approved_at IS NULL),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (status <> 'approved' OR (proof_at IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE TABLE farm.browser_device_challenges (
  challenge_id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES farm.browser_device_keys(key_id),
  session_id text NOT NULL REFERENCES farm.account_sessions(id),
  challenge jsonb NOT NULL CHECK (jsonb_typeof(challenge) = 'object'),
  issued_at bigint NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254680991),
  expires_at bigint NOT NULL CHECK (expires_at = issued_at + 60000),
  consumed_at bigint CHECK (consumed_at BETWEEN issued_at AND 9007199254740991),
  outcome text CHECK (outcome IN ('verified','rejected','expired')),
  CHECK ((consumed_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX browser_device_keys_account ON farm.browser_device_keys(account_id);
CREATE INDEX browser_device_challenges_key ON farm.browser_device_challenges(key_id);
CREATE FUNCTION farm.browser_device_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Browser device tombstones must be retained'; END IF;
  IF TG_TABLE_NAME = 'browser_device_keys' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'pending' OR NEW.proof_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Browser key must start unproven'; END IF;
    ELSE
      IF (NEW.key_id,NEW.farm_id,NEW.account_id,NEW.public_key,NEW.thumbprint,NEW.created_at) IS DISTINCT FROM (OLD.key_id,OLD.farm_id,OLD.account_id,OLD.public_key,OLD.thumbprint,OLD.created_at)
        OR (OLD.status = 'revoked' AND NEW IS DISTINCT FROM OLD)
        OR (OLD.status = 'approved' AND NEW.status NOT IN ('approved','revoked'))
        OR (OLD.proof_at IS NOT NULL AND (NEW.proof_at IS NULL OR NEW.proof_at < OLD.proof_at))
        OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at,NEW.approved_by) IS DISTINCT FROM (OLD.approved_at,OLD.approved_by)) THEN RAISE EXCEPTION 'Browser key identity and terminal decisions are immutable'; END IF;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      IF NEW.consumed_at IS NOT NULL OR NEW.outcome IS NOT NULL THEN RAISE EXCEPTION 'Challenge must start pending'; END IF;
    ELSIF (NEW.challenge_id,NEW.key_id,NEW.session_id,NEW.challenge,NEW.issued_at,NEW.expires_at) IS DISTINCT FROM (OLD.challenge_id,OLD.key_id,OLD.session_id,OLD.challenge,OLD.issued_at,OLD.expires_at)
      OR (OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Challenge identity and consumption are immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER browser_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.browser_device_keys FOR EACH ROW EXECUTE FUNCTION farm.browser_device_lifecycle();
CREATE TRIGGER browser_keys_no_truncate BEFORE TRUNCATE ON farm.browser_device_keys FOR EACH STATEMENT EXECUTE FUNCTION farm.browser_device_lifecycle();
CREATE TRIGGER browser_challenges_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.browser_device_challenges FOR EACH ROW EXECUTE FUNCTION farm.browser_device_lifecycle();
CREATE TRIGGER browser_challenges_no_truncate BEFORE TRUNCATE ON farm.browser_device_challenges FOR EACH STATEMENT EXECUTE FUNCTION farm.browser_device_lifecycle();
CREATE ROLE farm_browser_device_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE farm_browser_device_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_browser_device_runtime, farm_browser_device_reader;
GRANT SELECT ON farm.browser_device_keys TO farm_browser_device_runtime, farm_browser_device_reader;
GRANT INSERT ON farm.browser_device_keys, farm.browser_device_challenges TO farm_browser_device_runtime;
GRANT SELECT ON farm.browser_device_challenges, farm.session_accounts, farm.account_sessions, farm.memberships TO farm_browser_device_runtime;
GRANT UPDATE (status,proof_at,proof_session_id,approved_at,approved_by,revoked_at,revoked_by) ON farm.browser_device_keys TO farm_browser_device_runtime;
GRANT UPDATE (consumed_at,outcome) ON farm.browser_device_challenges TO farm_browser_device_runtime;
-- Row locks need UPDATE on a column. Existing guards forbid changing identity.
GRANT UPDATE (id) ON farm.session_accounts TO farm_browser_device_runtime;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_browser_device_runtime;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_browser_device_runtime;
