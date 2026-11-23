-- Expired items cannot be represented by the previous constraint: they were never released, so they become rejected.
ALTER TABLE farm.integration_jobs DISABLE TRIGGER integration_job_guard;
ALTER TABLE farm.integration_actions DISABLE TRIGGER integration_action_guard;
UPDATE farm.integration_jobs SET status = 'rejected' WHERE status = 'expired';
UPDATE farm.integration_actions SET status = 'rejected' WHERE status = 'expired';
ALTER TABLE farm.integration_jobs ENABLE TRIGGER integration_job_guard;
ALTER TABLE farm.integration_actions ENABLE TRIGGER integration_action_guard;
ALTER TABLE farm.integration_jobs DROP CONSTRAINT integration_jobs_status_check;
ALTER TABLE farm.integration_jobs ADD CONSTRAINT integration_jobs_status_check CHECK (status IN ('held', 'submitted', 'rejected'));
ALTER TABLE farm.integration_actions DROP CONSTRAINT integration_actions_status_check;
ALTER TABLE farm.integration_actions ADD CONSTRAINT integration_actions_status_check CHECK (status IN ('held', 'submitted', 'rejected'));
CREATE OR REPLACE FUNCTION farm.integration_job_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION farm.integration_action_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE grant_row farm.integration_app_grants%ROWTYPE; app_sandbox boolean; farm_sandbox boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO grant_row FROM farm.integration_app_grants g WHERE g.id = NEW.grant_id FOR SHARE;
    IF NOT FOUND OR grant_row.disabled_at IS NOT NULL OR grant_row.app_id <> NEW.app_id OR grant_row.farm_id <> NEW.farm_id THEN RAISE EXCEPTION 'Actions require an active grant of the app on the farm'; END IF;
    IF grant_row.printer_assignment_id IS NOT NULL AND grant_row.printer_assignment_id <> NEW.printer_assignment_id THEN RAISE EXCEPTION 'The grant does not cover this printer'; END IF;
    IF NOT (NEW.required_scope = ANY (grant_row.scopes)) THEN RAISE EXCEPTION 'The grant lacks the action scope'; END IF;
    IF NEW.status NOT IN ('held', 'submitted') OR (NEW.status = 'held') <> grant_row.requires_approval THEN RAISE EXCEPTION 'An action is held exactly when its grant requires approval'; END IF;
    IF NEW.action->>'action' NOT IN ('pause','resume','cancel','set_temperature','set_fan','home','set_light','set_speed','run_macro','load_filament','unload_filament') THEN RAISE EXCEPTION 'Unsupported API action'; END IF;
    IF (NEW.action->>'action' IN ('pause','resume','cancel')) <> (NEW.required_scope = 'control:basic') THEN RAISE EXCEPTION 'Action scope mismatch'; END IF;
    SELECT a.sandbox INTO app_sandbox FROM farm.integration_apps a WHERE a.id = NEW.app_id AND a.revoked_at IS NULL FOR SHARE;
    IF app_sandbox IS NULL THEN RAISE EXCEPTION 'Actions require an active app'; END IF;
    SELECT f.sandbox INTO farm_sandbox FROM farm.farms f WHERE f.id = NEW.farm_id FOR SHARE;
    IF app_sandbox AND NOT farm_sandbox THEN RAISE EXCEPTION 'Sandbox apps never reach non-sandbox farms'; END IF;
    IF NOT EXISTS (SELECT 1 FROM farm.printer_assignments p WHERE p.id = NEW.printer_assignment_id AND p.farm_id = NEW.farm_id AND p.revoked_at IS NULL FOR SHARE) THEN RAISE EXCEPTION 'Actions require an active printer assignment on the farm'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR (NEW.id, NEW.app_id, NEW.grant_id, NEW.farm_id, NEW.printer_assignment_id, NEW.idempotency_key, NEW.request_hash, NEW.action, NEW.required_scope, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.app_id, OLD.grant_id, OLD.farm_id, OLD.printer_assignment_id, OLD.idempotency_key, OLD.request_hash, OLD.action, OLD.required_scope, OLD.created_at) THEN RAISE EXCEPTION 'Action identity is immutable'; END IF;
  IF OLD.status <> NEW.status AND NOT (OLD.status = 'held' AND NEW.status IN ('submitted', 'rejected')) THEN RAISE EXCEPTION 'Illegal action status change'; END IF;
  IF NEW.updated_at < OLD.updated_at THEN RAISE EXCEPTION 'Action time moves forward'; END IF;
  RETURN NEW;
END; $$;

DROP OWNED BY farm_integration_approvals;
DROP ROLE farm_integration_approvals;
