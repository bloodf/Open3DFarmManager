CREATE TABLE farm.integration_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  app_id uuid REFERENCES farm.integration_apps(id),
  printer_assignment_id uuid REFERENCES farm.printer_assignments(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('app', 'owner', 'connector', 'system')),
  actor_id text CHECK (length(actor_id) <= 128),
  action text NOT NULL CHECK (action IN ('job.submitted', 'printer.action', 'approval.decided', 'connector.result', 'subscription.changed', 'credential.event')),
  resource_type text NOT NULL CHECK (resource_type IN ('job', 'action', 'approval', 'connector', 'subscription', 'credential')),
  resource_id text CHECK (length(resource_id) <= 128),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'held', 'approved', 'rejected', 'succeeded', 'failed', 'revoked', 'created', 'refused', 'unknown')),
  occurred_at bigint NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(details::text) <= 2048)
);
CREATE INDEX integration_audit_farm_time ON farm.integration_audit (farm_id, occurred_at DESC, id DESC);
CREATE INDEX integration_audit_app_time ON farm.integration_audit (farm_id, app_id, occurred_at DESC, id DESC);
CREATE INDEX integration_audit_printer_time ON farm.integration_audit (farm_id, printer_assignment_id, occurred_at DESC, id DESC);
CREATE FUNCTION farm.integration_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('farm.audit_pruning', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Integration audit entries are append-only';
END;
$$;
CREATE TRIGGER integration_audit_no_change BEFORE UPDATE OR DELETE ON farm.integration_audit FOR EACH ROW EXECUTE FUNCTION farm.integration_audit_immutable();
CREATE TRIGGER integration_audit_no_truncate BEFORE TRUNCATE ON farm.integration_audit FOR EACH STATEMENT EXECUTE FUNCTION farm.integration_audit_immutable();
CREATE FUNCTION farm.prune_integration_audit(retain_after bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE removed bigint;
BEGIN
 PERFORM set_config('farm.audit_pruning', 'on', true);
 DELETE FROM farm.integration_audit WHERE occurred_at < retain_after;
 GET DIAGNOSTICS removed = ROW_COUNT;
 RETURN removed;
END;
$$;
CREATE FUNCTION farm.integration_audit_prune_after_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  PERFORM farm.prune_integration_audit(NEW.occurred_at - 7776000000);
  RETURN NULL;
END;
$$;
CREATE TRIGGER integration_audit_retention AFTER INSERT ON farm.integration_audit FOR EACH ROW EXECUTE FUNCTION farm.integration_audit_prune_after_insert();
REVOKE ALL ON FUNCTION farm.integration_audit_immutable(), farm.integration_audit_prune_after_insert(), farm.prune_integration_audit(bigint) FROM PUBLIC;
