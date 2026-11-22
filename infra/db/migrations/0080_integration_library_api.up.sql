-- Library and replay scopes for the integration API, plus the audit and envelope
-- values those commands record. Databases that already applied 0040 pick the
-- expanded scope list up here.
CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 11
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;

ALTER TABLE farm.integration_envelopes
  DROP CONSTRAINT IF EXISTS integration_envelopes_required_scope_check;
ALTER TABLE farm.integration_envelopes
  ADD CONSTRAINT integration_envelopes_required_scope_check
  CHECK (required_scope IN ('jobs:start', 'jobs:write', 'control:basic', 'control:extended'));

ALTER TABLE farm.integration_audit
  DROP CONSTRAINT IF EXISTS integration_audit_action_check,
  DROP CONSTRAINT IF EXISTS integration_audit_resource_type_check;
ALTER TABLE farm.integration_audit
  ADD CONSTRAINT integration_audit_action_check
    CHECK (action IN ('job.submitted', 'printer.action', 'approval.decided', 'connector.result', 'subscription.changed', 'credential.event', 'library.changed')),
  ADD CONSTRAINT integration_audit_resource_type_check
    CHECK (resource_type IN ('job', 'action', 'approval', 'connector', 'subscription', 'credential', 'library'));

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
  CHECK (cardinality(events) BETWEEN 1 AND 7);

ALTER TABLE farm.integration_jobs
  ADD COLUMN library_version_id uuid,
  ADD COLUMN plate integer CHECK (plate IS NULL OR plate BETWEEN 1 AND 1000),
  ADD COLUMN storage_mode text CHECK (storage_mode IS NULL OR storage_mode IN ('server', 'connector'));

GRANT SELECT, INSERT ON farm.library_settings, farm.library_items, farm.library_blobs, farm.library_versions TO farm_integration_jobs;
GRANT UPDATE (storage_mode, updated_by, updated_at) ON farm.library_settings TO farm_integration_jobs;
