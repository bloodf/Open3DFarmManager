-- Allow subscriptions to include printer.alert.raised alongside the existing events.
DO $$
DECLARE
  name text;
BEGIN
  SELECT c.conname INTO name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'farm' AND t.relname = 'integration_webhooks' AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%cardinality(events)%';
  IF name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE farm.integration_webhooks DROP CONSTRAINT %I', name);
  END IF;
END $$;
ALTER TABLE farm.integration_webhooks
  ADD CONSTRAINT integration_webhooks_events_check
  CHECK (cardinality(events) BETWEEN 1 AND 8);
