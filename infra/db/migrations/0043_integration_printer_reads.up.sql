-- Integration read endpoints need assignment identity and the latest projection.
GRANT SELECT (agent_id, printer_key, created_at)
  ON farm.printer_assignments TO farm_integration_apps;
GRANT SELECT ON farm.printer_latest_state TO farm_integration_apps;
