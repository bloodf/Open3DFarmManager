REVOKE UPDATE (outcome, filename, print_duration_seconds, total_duration_seconds, filament_usage, ended_at, total_filament_grams)
  ON farm.job_history FROM farm_bambu_cloud;
REVOKE INSERT ON farm.job_history FROM farm_bambu_cloud;
REVOKE SELECT (farm_id, printer_key, bambu_cloud_task_id) ON farm.job_history FROM farm_bambu_cloud;
REVOKE SELECT ON farm.printer_assignments FROM farm_bambu_cloud;
CREATE OR REPLACE FUNCTION farm.job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job history rows are immutable'; END;
$$;
DROP INDEX farm.job_history_bambu_cloud_task;
ALTER TABLE farm.job_history DROP COLUMN bambu_cloud_task_id;
ALTER TABLE farm.job_history DROP COLUMN total_filament_grams;
