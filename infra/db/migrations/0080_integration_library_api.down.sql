REVOKE UPDATE (storage_mode, updated_by, updated_at) ON farm.library_settings FROM farm_integration_jobs;
REVOKE ALL PRIVILEGES ON farm.library_settings, farm.library_items, farm.library_blobs, farm.library_versions FROM farm_integration_jobs;

ALTER TABLE farm.integration_jobs
  DROP COLUMN storage_mode,
  DROP COLUMN plate,
  DROP COLUMN library_version_id;

ALTER TABLE farm.integration_webhooks DROP CONSTRAINT integration_webhooks_events_check;
ALTER TABLE farm.integration_webhooks
  ADD CONSTRAINT integration_webhooks_events_check
  CHECK (cardinality(events) BETWEEN 1 AND 6);

ALTER TABLE farm.integration_audit DROP CONSTRAINT integration_audit_resource_type_check;
ALTER TABLE farm.integration_audit DROP CONSTRAINT integration_audit_action_check;
ALTER TABLE farm.integration_audit
  ADD CONSTRAINT integration_audit_action_check
    CHECK (action IN ('job.submitted', 'printer.action', 'approval.decided', 'connector.result', 'subscription.changed', 'credential.event')),
  ADD CONSTRAINT integration_audit_resource_type_check
    CHECK (resource_type IN ('job', 'action', 'approval', 'connector', 'subscription', 'credential'));

ALTER TABLE farm.integration_envelopes DROP CONSTRAINT integration_envelopes_required_scope_check;
ALTER TABLE farm.integration_envelopes
  ADD CONSTRAINT integration_envelopes_required_scope_check
  CHECK (required_scope IN ('jobs:start', 'control:basic', 'control:extended'));

CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 8
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;
