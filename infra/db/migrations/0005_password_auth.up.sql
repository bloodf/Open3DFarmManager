CREATE TABLE farm.password_credentials (
  account_id text PRIMARY KEY REFERENCES farm.session_accounts(id),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_-]{3,64}$'),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 32 AND 1024),
  credential_version bigint NOT NULL DEFAULT 0 CHECK (credential_version BETWEEN 0 AND 9007199254740991)
);
CREATE FUNCTION farm.password_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.username <> OLD.username
     OR NEW.credential_version <> OLD.credential_version + 1 THEN
    RAISE EXCEPTION 'Credential replacement requires a fresh version and immutable identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER password_credential_guard BEFORE UPDATE ON farm.password_credentials
  FOR EACH ROW EXECUTE FUNCTION farm.password_credential_guard();
CREATE TABLE farm.auth_rate_limits (
  key text PRIMARY KEY CHECK (key ~ '^[as]:[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 61)
);
CREATE ROLE farm_password_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_session_runtime;
GRANT USAGE ON SCHEMA farm TO farm_password_auth;
GRANT SELECT ON farm.password_credentials TO farm_password_auth;
-- Row locks are needed for credential recheck; the trigger rejects a no-op update.
GRANT UPDATE (credential_version) ON farm.password_credentials TO farm_password_auth;
GRANT INSERT ON farm.account_sessions TO farm_password_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON farm.auth_rate_limits TO farm_password_auth;
