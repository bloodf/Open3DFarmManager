DROP FUNCTION farm.prune_telemetry(integer, integer, integer);
CREATE OR REPLACE FUNCTION farm.job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job history rows are immutable';
END;
$$;
DROP OWNED BY farm_telemetry_pruner, farm_telemetry_prune_owner;
DROP ROLE farm_telemetry_pruner;
DROP ROLE farm_telemetry_prune_owner;
