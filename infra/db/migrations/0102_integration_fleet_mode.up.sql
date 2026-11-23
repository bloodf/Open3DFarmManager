CREATE TABLE farm.integration_fleet_mode (
  printer_id uuid PRIMARY KEY REFERENCES farm.printer_assignments(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('in-service', 'maintenance')),
  version uuid NOT NULL,
  previous_mode text CHECK (previous_mode IN ('in-service', 'maintenance') AND previous_mode <> mode),
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id)
);

GRANT SELECT, INSERT ON farm.integration_fleet_mode TO farm_integration_apps;
GRANT UPDATE (mode, version, previous_mode, app_id)
  ON farm.integration_fleet_mode TO farm_integration_apps;
