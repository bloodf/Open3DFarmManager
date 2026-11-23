CREATE TABLE farm.integration_alert_lifecycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  printer_id uuid NOT NULL REFERENCES farm.printer_assignments(id) ON DELETE CASCADE,
  alert_key text NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  message text NOT NULL,
  opened_at bigint NOT NULL,
  resolved_at bigint CHECK (resolved_at >= opened_at)
);
CREATE UNIQUE INDEX integration_alert_open_key
  ON farm.integration_alert_lifecycle (printer_id, alert_key) WHERE resolved_at IS NULL;
CREATE INDEX integration_alert_recent
  ON farm.integration_alert_lifecycle (printer_id, opened_at DESC, id DESC);

GRANT SELECT, INSERT, DELETE ON farm.integration_alert_lifecycle TO farm_connector_telemetry_writer;
GRANT UPDATE (label, message, resolved_at) ON farm.integration_alert_lifecycle TO farm_connector_telemetry_writer;
GRANT SELECT ON farm.integration_alert_lifecycle TO farm_integration_apps;
CREATE TABLE farm.integration_alert_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES farm.integration_alert_lifecycle(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id),
  action text NOT NULL CHECK (action IN ('acknowledge', 'silence')),
  acted_at bigint NOT NULL,
  silenced_until bigint,
  CHECK ((action = 'silence') = (silenced_until IS NOT NULL))
);
CREATE INDEX integration_alert_actions_app ON farm.integration_alert_actions (alert_id, app_id);
GRANT SELECT, INSERT ON farm.integration_alert_actions TO farm_integration_apps;
