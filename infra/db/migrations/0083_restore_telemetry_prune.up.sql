CREATE OR REPLACE FUNCTION farm.job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF current_user = 'farm_telemetry_prune_owner' AND TG_OP = 'DELETE' THEN
  RETURN OLD;
END IF;
  IF OLD.bambu_cloud_task_id IS NOT NULL
    AND NEW.bambu_cloud_task_id = OLD.bambu_cloud_task_id
    AND (NEW.id, NEW.farm_id, NEW.agent_id, NEW.printer_key, NEW.bambu_cloud_task_id)
      IS NOT DISTINCT FROM (OLD.id, OLD.farm_id, OLD.agent_id, OLD.printer_key, OLD.bambu_cloud_task_id)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Job history rows are immutable';
END;
$$;

