-- Permit tool-temperature capabilities for the existing default control roles.
ALTER TABLE farm.pause_authority_challenges DROP CONSTRAINT control_capability_actions;
ALTER TABLE farm.pause_authority_challenges ADD CONSTRAINT control_capability_actions CHECK (capability IS NULL OR (capability ? 'actions' AND jsonb_typeof(capability->'actions') = 'array' AND jsonb_array_length(capability->'actions') BETWEEN 1 AND 33 AND capability->'actions' <@ '["pause","resume","cancel","emergency_stop","set_temperature","set_tool_temperature","set_fan","home","set_light","set_speed","start_print","firmware_restart","run_macro","load_filament","unload_filament","extrude","start_library_print","jog","motors_off","z_babystep","set_factor","set_led","set_pin","queue_op","service","exclude_object","power","timelapse","gcode","file_op","bed_mesh","config_write","confirm_collection"]'::jsonb AND (NOT (capability->'actions' ?| ARRAY['run_macro','power','bed_mesh','gcode','config_write']) OR COALESCE(capability->>'role' IN ('owner','admin'), false)) AND (NOT (capability->'actions' ? 'service') OR COALESCE(capability->>'role' = 'owner', false))));

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
    IF COALESCE(NEW.action->>'action', '') NOT IN ('pause','resume','cancel','set_temperature','set_tool_temperature','set_fan','home','set_light','set_speed','run_macro','load_filament','unload_filament','confirm_collection','job_pause','job_resume','job_cancel') THEN RAISE EXCEPTION 'Unsupported API action'; END IF;
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
