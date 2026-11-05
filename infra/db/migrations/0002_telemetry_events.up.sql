-- Immutable observed events. Retention and production role grants remain separate work.
CREATE TABLE farm.telemetry_events (
  farm_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  event_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (farm_id, agent_id, event_id)
);
