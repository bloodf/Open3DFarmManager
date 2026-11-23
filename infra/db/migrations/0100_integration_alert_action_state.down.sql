LOCK TABLE farm.integration_alert_actions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.integration_alert_actions WHERE action = 'acknowledge' AND silenced_until IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot roll back while combined alert state is retained';
  END IF;
END $$;
REVOKE UPDATE (action, acted_at, silenced_until) ON farm.integration_alert_actions FROM farm_integration_apps;
DROP INDEX farm.integration_alert_actions_one_per_app;
ALTER TABLE farm.integration_alert_actions
  ADD CONSTRAINT integration_alert_actions_check CHECK ((action = 'silence') = (silenced_until IS NOT NULL));
