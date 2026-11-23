DROP INDEX farm.integration_telemetry_printer_history;
REVOKE SELECT ON farm.telemetry_events, farm.connector_heartbeats FROM farm_integration_apps;
