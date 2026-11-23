LOCK TABLE farm.integration_fleet_mode IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.integration_fleet_mode) THEN
    RAISE EXCEPTION 'Cannot roll back while fleet mode versions are retained';
  END IF;
END;
$$;
DROP TABLE farm.integration_fleet_mode;
