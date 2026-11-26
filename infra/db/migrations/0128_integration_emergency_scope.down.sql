-- Refuse while anything uses the scope, then restore the 0125 definitions.
LOCK TABLE farm.integration_app_grants, farm.integration_actions, farm.integration_envelopes IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM farm.integration_app_grants WHERE 'control:emergency' = ANY (scopes)
  ) OR EXISTS (
    SELECT 1 FROM farm.integration_envelopes WHERE required_scope = 'control:emergency'
  ) OR EXISTS (
    SELECT 1 FROM farm.integration_actions WHERE required_scope = 'control:emergency'
  ) THEN
    RAISE EXCEPTION 'Cannot roll back while control:emergency is in use';
  END IF;
END;
$$;

-- Envelopes and actions the up step closed stay closed.

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
    IF COALESCE(NEW.action->>'action', '') NOT IN ('pause','resume','cancel','emergency_stop','set_temperature','set_tool_temperature','set_fan','home','set_light','set_speed','run_macro','load_filament','unload_filament','confirm_collection','job_pause','job_resume','job_cancel') THEN RAISE EXCEPTION 'Unsupported API action'; END IF;
    IF NEW.required_scope <> (CASE
      WHEN NEW.action->>'action' = 'confirm_collection' THEN 'plates:confirm'
      WHEN NEW.action->>'action' IN ('pause','resume','cancel','job_pause','job_resume','job_cancel') THEN 'control:basic'
      ELSE 'control:extended'
    END) THEN RAISE EXCEPTION 'Action scope mismatch'; END IF;
    SELECT a.sandbox INTO app_sandbox FROM farm.integration_apps a WHERE a.id = NEW.app_id AND a.revoked_at IS NULL FOR SHARE;
    IF app_sandbox IS NULL THEN RAISE EXCEPTION 'Actions require an active app'; END IF;
    SELECT f.sandbox INTO farm_sandbox FROM farm.farms f WHERE f.id = NEW.farm_id FOR SHARE;
    IF app_sandbox AND NOT farm_sandbox THEN RAISE EXCEPTION 'Sandbox apps never reach non-sandbox farms'; END IF;
    IF NOT EXISTS (SELECT 1 FROM farm.printer_assignments p WHERE p.id = NEW.printer_assignment_id AND p.farm_id = NEW.farm_id AND p.revoked_at IS NULL FOR SHARE) THEN RAISE EXCEPTION 'Actions require an active printer assignment on the farm'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR (NEW.id, NEW.app_id, NEW.grant_id, NEW.farm_id, NEW.printer_assignment_id, NEW.idempotency_key, NEW.request_hash, NEW.action, NEW.required_scope, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.app_id, OLD.grant_id, OLD.farm_id, OLD.printer_assignment_id, OLD.idempotency_key, OLD.request_hash, OLD.action, OLD.required_scope, OLD.created_at) THEN RAISE EXCEPTION 'Action identity is immutable'; END IF;
  IF OLD.status <> NEW.status AND NOT (OLD.status = 'held' AND NEW.status IN ('submitted', 'rejected', 'expired')) THEN RAISE EXCEPTION 'Illegal action status change'; END IF;
  IF NEW.updated_at < OLD.updated_at THEN RAISE EXCEPTION 'Action time moves forward'; END IF;
  RETURN NEW;
END; $$;

ALTER TABLE farm.integration_actions DROP CONSTRAINT integration_actions_required_scope_check;
ALTER TABLE farm.integration_actions ADD CONSTRAINT integration_actions_required_scope_check
  CHECK (required_scope IN ('control:basic', 'control:extended', 'plates:confirm'));

ALTER TABLE farm.integration_envelopes DROP CONSTRAINT integration_envelopes_required_scope_check;
ALTER TABLE farm.integration_envelopes ADD CONSTRAINT integration_envelopes_required_scope_check
  CHECK (required_scope IN ('jobs:start', 'jobs:write', 'control:basic', 'control:extended', 'plates:confirm'));

CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 18
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write','environment:read','plates:confirm','alerts:write','camera:view','inventory:write','environment:control','alerts:manage']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;
