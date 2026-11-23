LOCK TABLE farm.integration_alert_rules, farm.integration_notification_channels IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.integration_alert_rules)
    OR EXISTS (SELECT 1 FROM farm.integration_notification_channels) THEN
    RAISE EXCEPTION 'Cannot roll back while alert rule or notification channel settings are retained';
  END IF;
END;
$$;
DROP TABLE farm.integration_notification_channels;
DROP TABLE farm.integration_alert_rules;
