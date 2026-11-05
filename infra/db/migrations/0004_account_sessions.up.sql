-- Independent session state only. No passwords, bearer tokens or farm authorization.
CREATE TABLE farm.session_accounts (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  session_version bigint NOT NULL DEFAULT 0 CHECK (session_version BETWEEN 0 AND 9007199254740991),
  disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE farm.account_sessions (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  account_id text NOT NULL REFERENCES farm.session_accounts(id),
  account_version bigint NOT NULL CHECK (account_version BETWEEN 0 AND 9007199254740991),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  last_seen_at bigint NOT NULL CHECK (last_seen_at BETWEEN created_at AND 9007199254740991),
  absolute_expires_at bigint NOT NULL CHECK (absolute_expires_at > last_seen_at AND absolute_expires_at <= 9007199254740991),
  revoked_at bigint CHECK (revoked_at BETWEEN created_at AND 9007199254740991)
);
CREATE INDEX account_sessions_account_id ON farm.account_sessions(account_id);
CREATE FUNCTION farm.session_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Session state cannot be deleted or truncated';
  END IF;
  IF TG_TABLE_NAME = 'session_accounts' THEN
    IF NEW.id <> OLD.id OR NEW.session_version < OLD.session_version
       OR NEW.session_version > OLD.session_version + 1 THEN
      RAISE EXCEPTION 'Invalid account session transition';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
       OR NEW.account_version <> OLD.account_version OR NEW.created_at <> OLD.created_at
       OR NEW.absolute_expires_at <> OLD.absolute_expires_at
       OR NEW.last_seen_at < OLD.last_seen_at
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
       OR (OLD.revoked_at IS NOT NULL AND NEW.last_seen_at <> OLD.last_seen_at) THEN
      RAISE EXCEPTION 'Invalid session transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_accounts_guard BEFORE UPDATE OR DELETE ON farm.session_accounts
  FOR EACH ROW EXECUTE FUNCTION farm.session_state_guard();
CREATE TRIGGER account_sessions_guard BEFORE UPDATE OR DELETE ON farm.account_sessions
  FOR EACH ROW EXECUTE FUNCTION farm.session_state_guard();
CREATE TRIGGER session_accounts_no_truncate BEFORE TRUNCATE ON farm.session_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION farm.session_state_guard();
CREATE TRIGGER account_sessions_no_truncate BEFORE TRUNCATE ON farm.account_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION farm.session_state_guard();
CREATE ROLE farm_session_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_session_runtime;
GRANT SELECT ON farm.session_accounts, farm.account_sessions TO farm_session_runtime;
GRANT UPDATE (session_version) ON farm.session_accounts TO farm_session_runtime;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_session_runtime;
