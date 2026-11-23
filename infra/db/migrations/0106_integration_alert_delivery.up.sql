CREATE TABLE farm.integration_notification_outbox (
  farm_id uuid NOT NULL,
  app_id uuid NOT NULL,
  event_id uuid NOT NULL,
  printer_id uuid REFERENCES farm.printer_assignments(id) ON DELETE CASCADE,
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  PRIMARY KEY (farm_id, app_id, event_id),
  FOREIGN KEY (farm_id, app_id) REFERENCES farm.integration_notification_channels(farm_id, app_id) ON DELETE CASCADE
);
CREATE INDEX integration_notification_outbox_due ON farm.integration_notification_outbox (next_at)
  WHERE status = 'pending';

GRANT SELECT, INSERT ON farm.integration_notification_outbox TO farm_integration_apps;
GRANT UPDATE (status, attempts, next_at) ON farm.integration_notification_outbox TO farm_integration_apps;

-- Retain observations and their resolution history even when an alert is suppressed.
ALTER TABLE farm.integration_alert_lifecycle ADD COLUMN raised boolean NOT NULL DEFAULT true;

CREATE FUNCTION farm.integration_alert_enabled(target_farm uuid, alert_kind text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, farm, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM farm.integration_alert_rules
    WHERE farm_id = target_farm AND kind = alert_kind AND NOT enabled
  )
$$;

CREATE FUNCTION farm.integration_notification_allowed(target_app uuid, target_farm uuid, printer uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, farm, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM farm.integration_app_grants g
    JOIN farm.integration_apps a ON a.id = g.app_id
    JOIN farm.farms f ON f.id = g.farm_id
    JOIN farm.memberships m ON m.farm_id = g.farm_id AND m.account_id = g.created_by
    JOIN farm.session_accounts s ON s.id = m.account_id
    WHERE g.app_id = target_app AND g.farm_id = target_farm
      AND a.revoked_at IS NULL AND (NOT a.sandbox OR f.sandbox)
      AND g.printer_assignment_id IS NULL AND g.disabled_at IS NULL
      AND 'alerts:manage' = ANY(g.scopes) AND NOT g.requires_approval
      AND m.role = 'owner' AND m.revoked_at IS NULL AND NOT s.disabled
      AND (printer IS NULL OR EXISTS (
        SELECT 1 FROM farm.printer_assignments p
        WHERE p.id = printer AND p.farm_id = target_farm AND p.revoked_at IS NULL
      ))
  )
$$;

CREATE FUNCTION farm.enqueue_integration_alert(target_farm uuid, printer uuid, event jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  event_uuid uuid := (event->>'id')::uuid;
BEGIN
  IF NOT farm.integration_alert_enabled(target_farm, event#>>'{data,alert,kind}') THEN
    RETURN false;
  END IF;
  INSERT INTO farm.integration_webhook_outbox (subscription_id, event_id, farm_id, printer_id, body)
  SELECT w.id, event_uuid, target_farm, printer, event
  FROM farm.integration_webhooks w
  WHERE 'printer.alert.raised' = ANY(w.events)
    AND farm.integration_webhook_allowed(w.app_id, target_farm, printer);
  INSERT INTO farm.integration_notification_outbox (farm_id, app_id, event_id, printer_id, body)
  SELECT c.farm_id, c.app_id, event_uuid, printer, event
  FROM farm.integration_notification_channels c
  WHERE c.farm_id = target_farm AND farm.integration_notification_allowed(c.app_id, target_farm, printer);
  RETURN true;
END
$$;

CREATE FUNCTION farm.capture_integration_alert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  assignment record;
BEGIN
  SELECT p.farm_id, p.printer_key INTO STRICT assignment FROM farm.printer_assignments p WHERE p.id = NEW.printer_id;
  IF TG_WHEN = 'BEFORE' THEN
    NEW.raised := farm.integration_alert_enabled(assignment.farm_id, NEW.kind);
    RETURN NEW;
  END IF;
  PERFORM farm.enqueue_integration_alert(assignment.farm_id, NEW.printer_id, jsonb_build_object(
    'id', NEW.id, 'type', 'printer.alert.raised', 'occurredAt', NEW.opened_at,
    'data', jsonb_build_object(
      'farmId', assignment.farm_id, 'printerId', NEW.printer_id, 'printerKey', assignment.printer_key,
      'alert', jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'label', NEW.label, 'message', NEW.message)
    )
  ));
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION farm.integration_alert_enabled(uuid, text),
  farm.integration_notification_allowed(uuid, uuid, uuid),
  farm.enqueue_integration_alert(uuid, uuid, jsonb),
  farm.capture_integration_alert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.integration_alert_enabled(uuid, text),
  farm.integration_notification_allowed(uuid, uuid, uuid),
  farm.enqueue_integration_alert(uuid, uuid, jsonb) TO farm_integration_apps;

CREATE TRIGGER integration_alert_rule BEFORE INSERT ON farm.integration_alert_lifecycle
  FOR EACH ROW EXECUTE FUNCTION farm.capture_integration_alert();
-- Only a newly inserted lifecycle row may enqueue deliveries.
CREATE TRIGGER integration_alert_delivery AFTER INSERT ON farm.integration_alert_lifecycle
  FOR EACH ROW WHEN (NEW.raised) EXECUTE FUNCTION farm.capture_integration_alert();
