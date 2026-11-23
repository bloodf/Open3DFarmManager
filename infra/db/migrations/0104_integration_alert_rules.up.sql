CREATE TABLE farm.integration_alert_rules (
  farm_id uuid NOT NULL REFERENCES farm.farms(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'error', 'connector-storage-degraded', 'offline-or-stale', 'paused',
    'finished-bed-clear', 'low-slot', 'firmware-update'
  )),
  enabled boolean NOT NULL,
  PRIMARY KEY (farm_id, kind)
);

CREATE TABLE farm.integration_notification_channels (
  farm_id uuid NOT NULL REFERENCES farm.farms(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id) ON DELETE CASCADE,
  sealed_configuration text NOT NULL CHECK (sealed_configuration LIKE 'O3W1.%'),
  PRIMARY KEY (farm_id, app_id)
);

GRANT SELECT, INSERT ON farm.integration_alert_rules TO farm_integration_apps;
GRANT UPDATE (enabled) ON farm.integration_alert_rules TO farm_integration_apps;
GRANT SELECT, INSERT ON farm.integration_notification_channels TO farm_integration_apps;
GRANT UPDATE (sealed_configuration) ON farm.integration_notification_channels TO farm_integration_apps;
