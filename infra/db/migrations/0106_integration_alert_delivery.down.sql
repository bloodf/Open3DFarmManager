LOCK TABLE farm.integration_notification_outbox IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.integration_notification_outbox WHERE status = 'pending') THEN
    RAISE EXCEPTION 'Cannot roll back while notification deliveries are pending';
  END IF;
END;
$$;

DROP TRIGGER integration_alert_delivery ON farm.integration_alert_lifecycle;
DROP TRIGGER integration_alert_rule ON farm.integration_alert_lifecycle;
DROP FUNCTION farm.capture_integration_alert();
DROP FUNCTION farm.enqueue_integration_alert(uuid, uuid, jsonb);
DROP FUNCTION farm.integration_notification_allowed(uuid, uuid, uuid);
DROP FUNCTION farm.integration_alert_enabled(uuid, text);
ALTER TABLE farm.integration_alert_lifecycle DROP COLUMN raised;
DROP TABLE farm.integration_notification_outbox;
