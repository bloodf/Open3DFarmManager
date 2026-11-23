LOCK TABLE farm.integration_alert_lifecycle, farm.integration_alert_actions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.integration_alert_lifecycle) THEN
    RAISE EXCEPTION 'Cannot roll back while alert lifecycle rows are retained';
  END IF;
END;
$$;
DROP TABLE farm.integration_alert_actions;
DROP TABLE farm.integration_alert_lifecycle;
