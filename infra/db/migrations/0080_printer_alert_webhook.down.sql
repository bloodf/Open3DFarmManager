ALTER TABLE farm.integration_webhooks DROP CONSTRAINT integration_webhooks_events_check;
ALTER TABLE farm.integration_webhooks
  ADD CONSTRAINT integration_webhooks_events_check
  CHECK (cardinality(events) BETWEEN 1 AND 7);
