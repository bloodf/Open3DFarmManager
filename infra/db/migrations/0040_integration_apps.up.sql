-- Third-party integration apps: apps, hashed credentials and per-farm / per-printer grants.
-- Additive only. Farms gain a sandbox flag; a sandbox app can never hold a grant on a
-- non-sandbox farm (enforced here by trigger, so no write path can bypass it).
ALTER TABLE farm.farms ADD COLUMN sandbox boolean NOT NULL DEFAULT false;

CREATE TABLE farm.integration_apps (
  id uuid PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128 AND name !~ '[[:cntrl:]]'),
  sandbox boolean NOT NULL,
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  created_by text NOT NULL REFERENCES farm.session_accounts(id),
  revoked_at bigint CHECK (revoked_at BETWEEN created_at AND 9007199254740991)
);
CREATE INDEX integration_apps_farm ON farm.integration_apps (farm_id);

-- The secret column holds only a digest: 'sha256:' + 64 lowercase hex. A plaintext secret cannot satisfy the check.
CREATE TABLE farm.integration_app_credentials (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id),
  client_id text COLLATE "C" NOT NULL UNIQUE CHECK (client_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  revoked_at bigint CHECK (revoked_at BETWEEN created_at AND 9007199254740991)
);
CREATE INDEX integration_app_credentials_app ON farm.integration_app_credentials (app_id);

-- Scopes exactly as in docs/api/openapi-v1.yaml: a non-empty set of known scopes without duplicates.
CREATE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 11
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;

CREATE TABLE farm.integration_app_grants (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id),
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  printer_assignment_id uuid REFERENCES farm.printer_assignments(id),
  scopes text[] NOT NULL CHECK (farm.integration_scopes_valid(scopes)),
  requires_approval boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  created_by text NOT NULL REFERENCES farm.session_accounts(id),
  disabled_at bigint CHECK (disabled_at BETWEEN created_at AND 9007199254740991),
  disabled_reason text CHECK (disabled_reason IN ('revoked', 'assignment-revoked')),
  CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
CREATE INDEX integration_app_grants_app ON farm.integration_app_grants (app_id);
CREATE INDEX integration_app_grants_farm ON farm.integration_app_grants (farm_id);
CREATE INDEX integration_app_grants_assignment ON farm.integration_app_grants (printer_assignment_id) WHERE printer_assignment_id IS NOT NULL;

-- Row guards. Functions are SECURITY DEFINER with a pinned search_path so the least-privilege role needs no lock rights on the rows they check.
CREATE FUNCTION farm.integration_app_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Apps start active'; END IF;
    IF NEW.sandbox AND NOT (SELECT f.sandbox FROM farm.farms f WHERE f.id = NEW.farm_id FOR SHARE) THEN
      RAISE EXCEPTION 'A sandbox app requires a sandbox farm';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.farm_id, NEW.name, NEW.sandbox, NEW.created_at, NEW.created_by)
        IS DISTINCT FROM (OLD.id, OLD.farm_id, OLD.name, OLD.sandbox, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'App identity is immutable; an app is only revoked once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_app_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.integration_apps
  FOR EACH ROW EXECUTE FUNCTION farm.integration_app_guard();
CREATE TRIGGER integration_app_no_truncate BEFORE TRUNCATE ON farm.integration_apps
  FOR EACH STATEMENT EXECUTE FUNCTION farm.integration_app_guard();

CREATE FUNCTION farm.integration_app_credential_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM farm.integration_apps a WHERE a.id = NEW.app_id AND a.revoked_at IS NULL FOR SHARE) THEN
      RAISE EXCEPTION 'Credentials start active on an active app';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.app_id, NEW.client_id, NEW.secret_hash, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.app_id, OLD.client_id, OLD.secret_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'Credential secrets are immutable; a credential is only revoked once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_app_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.integration_app_credentials
  FOR EACH ROW EXECUTE FUNCTION farm.integration_app_credential_guard();
CREATE TRIGGER integration_app_credential_no_truncate BEFORE TRUNCATE ON farm.integration_app_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION farm.integration_app_credential_guard();

CREATE FUNCTION farm.integration_app_grant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  app_sandbox boolean;
  farm_sandbox boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a.sandbox INTO app_sandbox FROM farm.integration_apps a WHERE a.id = NEW.app_id AND a.revoked_at IS NULL FOR SHARE;
    IF app_sandbox IS NULL THEN RAISE EXCEPTION 'Grants require an active app'; END IF;
    SELECT f.sandbox INTO farm_sandbox FROM farm.farms f WHERE f.id = NEW.farm_id FOR SHARE;
    IF farm_sandbox IS NULL THEN RAISE EXCEPTION 'Grants require a known farm'; END IF;
    IF app_sandbox AND NOT farm_sandbox THEN
      RAISE EXCEPTION 'A sandbox app cannot hold a grant on a non-sandbox farm';
    END IF;
    IF NEW.disabled_at IS NOT NULL THEN RAISE EXCEPTION 'Grants start enabled'; END IF;
    IF NEW.printer_assignment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM farm.printer_assignments p
      WHERE p.id = NEW.printer_assignment_id AND p.farm_id = NEW.farm_id AND p.revoked_at IS NULL FOR SHARE
    ) THEN
      RAISE EXCEPTION 'Printer-scoped grants require an active assignment on the same farm';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD.disabled_at IS NOT NULL OR NEW.disabled_at IS NULL
     OR (NEW.id, NEW.app_id, NEW.farm_id, NEW.printer_assignment_id, NEW.scopes, NEW.requires_approval, NEW.created_at, NEW.created_by)
        IS DISTINCT FROM (OLD.id, OLD.app_id, OLD.farm_id, OLD.printer_assignment_id, OLD.scopes, OLD.requires_approval, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'Grants are immutable; a grant is only disabled once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_app_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.integration_app_grants
  FOR EACH ROW EXECUTE FUNCTION farm.integration_app_grant_guard();
CREATE TRIGGER integration_app_grant_no_truncate BEFORE TRUNCATE ON farm.integration_app_grants
  FOR EACH STATEMENT EXECUTE FUNCTION farm.integration_app_grant_guard();

-- Revoking a printer assignment disables every printer-scoped grant on it, in the same statement's transaction.
CREATE FUNCTION farm.integration_app_assignment_revoked() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE farm.integration_app_grants
       SET disabled_at = greatest(NEW.revoked_at, created_at), disabled_reason = 'assignment-revoked'
     WHERE printer_assignment_id = NEW.id AND disabled_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER integration_app_assignment_revoked AFTER UPDATE ON farm.printer_assignments
  FOR EACH ROW EXECUTE FUNCTION farm.integration_app_assignment_revoked();

-- A farm cannot stop being a sandbox while a sandbox app is registered on it or holds a grant on it.
CREATE FUNCTION farm.integration_farm_sandbox_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  IF OLD.sandbox AND NOT NEW.sandbox AND (
    EXISTS (SELECT 1 FROM farm.integration_apps a WHERE a.farm_id = NEW.id AND a.sandbox)
    OR EXISTS (SELECT 1 FROM farm.integration_app_grants g JOIN farm.integration_apps a ON a.id = g.app_id WHERE g.farm_id = NEW.id AND a.sandbox)
  ) THEN
    RAISE EXCEPTION 'A farm with sandbox apps or grants cannot leave sandbox mode';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_farm_sandbox_guard BEFORE UPDATE OF sandbox ON farm.farms
  FOR EACH ROW EXECUTE FUNCTION farm.integration_farm_sandbox_guard();

REVOKE ALL ON FUNCTION farm.integration_app_guard(), farm.integration_app_credential_guard(), farm.integration_app_grant_guard(),
  farm.integration_app_assignment_revoked(), farm.integration_farm_sandbox_guard() FROM PUBLIC;

-- Least-privilege role: owner authorization reads (same shape as printer ownership), inserts, and one-way disable updates.
CREATE ROLE farm_integration_apps NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_integration_apps;
GRANT SELECT ON farm.session_accounts, farm.memberships, farm.integration_apps, farm.integration_app_credentials, farm.integration_app_grants TO farm_integration_apps;
GRANT SELECT (id, sandbox) ON farm.farms TO farm_integration_apps;
GRANT SELECT (id, farm_id, revoked_at) ON farm.printer_assignments TO farm_integration_apps;
GRANT UPDATE (id) ON farm.session_accounts TO farm_integration_apps;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_integration_apps;
GRANT INSERT ON farm.integration_apps, farm.integration_app_credentials, farm.integration_app_grants TO farm_integration_apps;
GRANT UPDATE (revoked_at) ON farm.integration_apps, farm.integration_app_credentials TO farm_integration_apps;
GRANT UPDATE (disabled_at, disabled_reason) ON farm.integration_app_grants TO farm_integration_apps;
