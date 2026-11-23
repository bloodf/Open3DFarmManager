-- The integration API reads only observations for assignments authorized in its handler.
GRANT SELECT ON farm.telemetry_events, farm.connector_heartbeats TO farm_integration_apps;
CREATE INDEX integration_telemetry_printer_history ON farm.telemetry_events
  (farm_id, agent_id, (payload->'state'->>'printerKey'), ((payload->'state'->>'observedAt')::bigint), event_id)
  WHERE payload->>'kind' = 'printer-state'
    AND payload->'state'->>'observedAt' ~ '^[0-9]{1,16}$';
