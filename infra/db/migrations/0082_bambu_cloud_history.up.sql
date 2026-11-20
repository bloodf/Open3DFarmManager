ALTER TABLE farm.job_history ADD COLUMN bambu_cloud_task_id text
  CHECK (bambu_cloud_task_id IS NULL OR char_length(bambu_cloud_task_id) BETWEEN 1 AND 128);
ALTER TABLE farm.job_history ADD COLUMN total_filament_grams double precision
  CHECK (total_filament_grams IS NULL OR total_filament_grams BETWEEN 0 AND 100000);
CREATE UNIQUE INDEX job_history_bambu_cloud_task
  ON farm.job_history (farm_id, printer_key, bambu_cloud_task_id)
  WHERE bambu_cloud_task_id IS NOT NULL;

CREATE OR REPLACE FUNCTION farm.job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bambu_cloud_task_id IS NOT NULL
    AND NEW.bambu_cloud_task_id = OLD.bambu_cloud_task_id
    AND (NEW.id, NEW.farm_id, NEW.agent_id, NEW.printer_key, NEW.bambu_cloud_task_id)
      IS NOT DISTINCT FROM (OLD.id, OLD.farm_id, OLD.agent_id, OLD.printer_key, OLD.bambu_cloud_task_id)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Job history rows are immutable';
END;
$$;

GRANT SELECT ON farm.printer_assignments TO farm_bambu_cloud;
GRANT SELECT (farm_id, printer_key, bambu_cloud_task_id) ON farm.job_history TO farm_bambu_cloud;
GRANT INSERT ON farm.job_history TO farm_bambu_cloud;
GRANT UPDATE (outcome, filename, print_duration_seconds, total_duration_seconds, filament_usage, ended_at, total_filament_grams)
  ON farm.job_history TO farm_bambu_cloud;
