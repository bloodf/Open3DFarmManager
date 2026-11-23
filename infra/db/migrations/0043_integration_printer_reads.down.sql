REVOKE SELECT ON farm.printer_latest_state FROM farm_integration_apps;
REVOKE SELECT (agent_id, printer_key, created_at)
  ON farm.printer_assignments FROM farm_integration_apps;
