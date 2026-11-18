-- API-submitted print jobs. One row per accepted `POST /printers/{id}/jobs`.
-- The row keeps only the file reference (HTTPS URL, SHA-256, size): the server never downloads or stores the file.
-- `held` waits for an operator decision; `submitted` jobs are delivered through farm.integration_envelopes
-- (resource_id = the job id), which carries the delivery and Connector outcome.
CREATE TABLE farm.integration_jobs (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id),
  grant_id uuid NOT NULL REFERENCES farm.integration_app_grants(id),
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  printer_assignment_id uuid NOT NULL REFERENCES farm.printer_assignments(id),
  idempotency_key text COLLATE "C" NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  -- SHA-256 of the validated request (printer, file URL, checksum, size, display name): a replay must match it.
  request_hash text COLLATE "C" NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  file_url text NOT NULL CHECK (length(file_url) <= 2048 AND file_url ~ '^https://'),
  sha256 text COLLATE "C" NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 9007199254740991),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 255 AND display_name !~ '[[:cntrl:]]'),
  status text NOT NULL CHECK (status IN ('held', 'submitted', 'rejected')),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  UNIQUE (app_id, idempotency_key)
);
CREATE INDEX integration_jobs_printer ON farm.integration_jobs (printer_assignment_id, created_at DESC);
CREATE INDEX integration_jobs_app ON farm.integration_jobs (app_id, created_at DESC);

-- Insert and change guard. A job needs an active grant with `jobs:start` on its printer and an app allowed on the farm;
-- it is held exactly when that grant requires approval. After insert only a held job may be decided.
CREATE FUNCTION farm.integration_job_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  app_sandbox boolean;
  farm_sandbox boolean;
  grant_row farm.integration_app_grants%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO grant_row FROM farm.integration_app_grants g WHERE g.id = NEW.grant_id FOR SHARE;
    IF NOT FOUND OR grant_row.disabled_at IS NOT NULL OR grant_row.app_id <> NEW.app_id OR grant_row.farm_id <> NEW.farm_id THEN
      RAISE EXCEPTION 'Jobs require an active grant of the app on the farm';
    END IF;
    IF grant_row.printer_assignment_id IS NOT NULL AND grant_row.printer_assignment_id <> NEW.printer_assignment_id THEN
      RAISE EXCEPTION 'The grant does not cover this printer';
    END IF;
    IF NOT ('jobs:start' = ANY (grant_row.scopes)) THEN
      RAISE EXCEPTION 'The grant lacks jobs:start';
    END IF;
    IF NEW.status NOT IN ('held', 'submitted') OR (NEW.status = 'held') <> grant_row.requires_approval THEN
      RAISE EXCEPTION 'A job is held exactly when its grant requires approval';
    END IF;
    SELECT a.sandbox INTO app_sandbox FROM farm.integration_apps a WHERE a.id = NEW.app_id AND a.revoked_at IS NULL FOR SHARE;
    IF app_sandbox IS NULL THEN RAISE EXCEPTION 'Jobs require an active app'; END IF;
    SELECT f.sandbox INTO farm_sandbox FROM farm.farms f WHERE f.id = NEW.farm_id FOR SHARE;
    IF app_sandbox AND NOT farm_sandbox THEN
      RAISE EXCEPTION 'A sandbox app never reaches a non-sandbox farm';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM farm.printer_assignments p
      WHERE p.id = NEW.printer_assignment_id AND p.farm_id = NEW.farm_id AND p.revoked_at IS NULL FOR SHARE
    ) THEN
      RAISE EXCEPTION 'Jobs require an active printer assignment on the farm';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE'
     OR (NEW.id, NEW.app_id, NEW.grant_id, NEW.farm_id, NEW.printer_assignment_id, NEW.idempotency_key, NEW.request_hash,
         NEW.file_url, NEW.sha256, NEW.size_bytes, NEW.display_name, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.app_id, OLD.grant_id, OLD.farm_id, OLD.printer_assignment_id, OLD.idempotency_key, OLD.request_hash,
         OLD.file_url, OLD.sha256, OLD.size_bytes, OLD.display_name, OLD.created_at) THEN
    RAISE EXCEPTION 'Job identity is immutable';
  END IF;
  IF OLD.status <> NEW.status AND NOT (OLD.status = 'held' AND NEW.status IN ('submitted', 'rejected')) THEN
    RAISE EXCEPTION 'Illegal job status change % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN RAISE EXCEPTION 'Job time moves forward'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_job_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.integration_jobs
  FOR EACH ROW EXECUTE FUNCTION farm.integration_job_guard();
CREATE TRIGGER integration_job_no_truncate BEFORE TRUNCATE ON farm.integration_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION farm.integration_job_guard();
REVOKE ALL ON FUNCTION farm.integration_job_guard() FROM PUBLIC;

-- Least-privilege role: store a job and its audit entry in one transaction, read the target printer and the envelope id.
-- The API runtime login is a member of this role and of farm_integration_delivery.
CREATE ROLE farm_integration_jobs NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_integration_jobs;
GRANT SELECT, INSERT ON farm.integration_jobs TO farm_integration_jobs;
GRANT SELECT (id, sandbox) ON farm.farms TO farm_integration_jobs;
GRANT SELECT (id, farm_id, agent_id, revoked_at) ON farm.printer_assignments TO farm_integration_jobs;
GRANT SELECT (cmd_id, kind, resource_id) ON farm.integration_envelopes TO farm_integration_jobs;
GRANT INSERT ON farm.integration_audit TO farm_integration_jobs;
