-- The integration history route reads bounded transition diagnostics by assignment.
CREATE INDEX integration_telemetry_transition_history ON farm.telemetry_events
  (farm_id, agent_id, (payload->'transition'->>'printerKey'), ((payload->'transition'->>'observedAt')::bigint), event_id)
  WHERE payload->>'kind' = 'printer-transition'
    AND payload->'transition'->>'observedAt' ~ '^[0-9]{1,16}$';
