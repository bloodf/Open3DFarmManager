-- Signed command envelopes that deliver API jobs and actions to a Connector.
-- One row per envelope: the exact signed wire text, a one-way status machine and the Connector's result.
-- `sending` is claimed before the inbox write and is never claimed again, so an uncertain delivery is never resent.
CREATE TABLE farm.integration_envelopes (
  cmd_id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id),
  grant_id uuid NOT NULL REFERENCES farm.integration_app_grants(id),
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  agent_id uuid NOT NULL REFERENCES farm.connector_enrollments(agent_id),
  printer_assignment_id uuid NOT NULL REFERENCES farm.printer_assignments(id),
  kind text NOT NULL CHECK (kind IN ('job', 'action')),
  resource_id uuid NOT NULL,
  required_scope text NOT NULL CHECK (required_scope IN ('jobs:start', 'control:basic', 'control:extended')),
  nonce text COLLATE "C" NOT NULL UNIQUE CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  -- The signed frame exactly as it is sent; bounded like the protocol limit.
  wire text NOT NULL CHECK (octet_length(wire) BETWEEN 1 AND 4096),
  issued_at bigint NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at bigint NOT NULL CHECK (expires_at BETWEEN issued_at + 1000 AND issued_at + 300000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sending', 'sent', 'delivered', 'refused', 'started', 'completed', 'cancelled', 'failed',
    'expired', 'rejected', 'outcome-unknown')),
  refusal_code text CHECK (refusal_code IN ('printer-busy', 'not-ready', 'wrong-state', 'checksum-mismatch', 'grant-revoked', 'expired', 'unsupported')),
  result_detail text CHECK (length(result_detail) <= 500),
  history_entry_id text CHECK (history_entry_id ~ '^[0-9]{1,19}$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  CHECK (kind = 'job' OR status NOT IN ('started', 'cancelled')),
  CHECK ((required_scope = 'jobs:start') = (kind = 'job')),
  CHECK ((status = 'refused') = (refusal_code IS NOT NULL)),
  CHECK (history_entry_id IS NULL OR status IN ('completed', 'cancelled', 'failed'))
);
-- One envelope per API resource: a retry of the same job or action never gets a second command.
CREATE UNIQUE INDEX integration_envelopes_resource ON farm.integration_envelopes (kind, resource_id);
CREATE INDEX integration_envelopes_agent_open ON farm.integration_envelopes (farm_id, agent_id, created_at) WHERE status = 'pending';
CREATE INDEX integration_envelopes_due ON farm.integration_envelopes (expires_at) WHERE status IN ('pending', 'sending', 'sent');
CREATE INDEX integration_envelopes_app ON farm.integration_envelopes (app_id, created_at DESC);

-- Insert and transition guard. Statuses only move forward; final statuses never change; identity columns are immutable.
CREATE FUNCTION farm.integration_envelope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  app_sandbox boolean;
  farm_sandbox boolean;
  grant_row farm.integration_app_grants%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.refusal_code IS NOT NULL OR NEW.result_detail IS NOT NULL OR NEW.history_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Envelopes start pending';
    END IF;
    SELECT * INTO grant_row FROM farm.integration_app_grants g WHERE g.id = NEW.grant_id FOR SHARE;
    IF NOT FOUND OR grant_row.disabled_at IS NOT NULL OR grant_row.app_id <> NEW.app_id OR grant_row.farm_id <> NEW.farm_id THEN
      RAISE EXCEPTION 'Envelopes require an active grant of the app on the farm';
    END IF;
    IF grant_row.printer_assignment_id IS NOT NULL AND grant_row.printer_assignment_id <> NEW.printer_assignment_id THEN
      RAISE EXCEPTION 'The grant does not cover this printer';
    END IF;
    IF NOT (NEW.required_scope = ANY (grant_row.scopes)) THEN
      RAISE EXCEPTION 'The grant lacks the required scope';
    END IF;
    SELECT a.sandbox INTO app_sandbox FROM farm.integration_apps a WHERE a.id = NEW.app_id AND a.revoked_at IS NULL FOR SHARE;
    IF app_sandbox IS NULL THEN RAISE EXCEPTION 'Envelopes require an active app'; END IF;
    SELECT f.sandbox INTO farm_sandbox FROM farm.farms f WHERE f.id = NEW.farm_id FOR SHARE;
    IF app_sandbox AND NOT farm_sandbox THEN
      RAISE EXCEPTION 'A sandbox app never reaches a non-sandbox farm';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM farm.printer_assignments p
      WHERE p.id = NEW.printer_assignment_id AND p.farm_id = NEW.farm_id AND p.agent_id = NEW.agent_id AND p.revoked_at IS NULL FOR SHARE
    ) THEN
      RAISE EXCEPTION 'Envelopes require an active assignment on the agent';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE'
     OR (NEW.cmd_id, NEW.app_id, NEW.grant_id, NEW.farm_id, NEW.agent_id, NEW.printer_assignment_id, NEW.kind, NEW.resource_id,
         NEW.required_scope, NEW.nonce, NEW.wire, NEW.issued_at, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.cmd_id, OLD.app_id, OLD.grant_id, OLD.farm_id, OLD.agent_id, OLD.printer_assignment_id, OLD.kind, OLD.resource_id,
         OLD.required_scope, OLD.nonce, OLD.wire, OLD.issued_at, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Envelope identity is immutable';
  END IF;
  IF OLD.status = NEW.status THEN
    IF (NEW.refusal_code, NEW.result_detail, NEW.history_entry_id)
       IS DISTINCT FROM (OLD.refusal_code, OLD.result_detail, OLD.history_entry_id) THEN
      RAISE EXCEPTION 'A result is recorded once';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('sending', 'expired', 'rejected'))
    -- A claim whose inbox had no live socket proved nothing was sent and may be claimed again.
    OR (OLD.status = 'sending' AND NEW.status IN ('pending', 'sent', 'outcome-unknown', 'delivered', 'refused', 'started', 'completed', 'cancelled', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('outcome-unknown', 'delivered', 'refused', 'started', 'completed', 'cancelled', 'failed'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('started', 'completed', 'cancelled', 'failed'))
    OR (OLD.status = 'started' AND NEW.status IN ('completed', 'cancelled', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Illegal envelope status change % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN RAISE EXCEPTION 'Envelope time moves forward'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER integration_envelope_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.integration_envelopes
  FOR EACH ROW EXECUTE FUNCTION farm.integration_envelope_guard();
CREATE TRIGGER integration_envelope_no_truncate BEFORE TRUNCATE ON farm.integration_envelopes
  FOR EACH STATEMENT EXECUTE FUNCTION farm.integration_envelope_guard();
REVOKE ALL ON FUNCTION farm.integration_envelope_guard() FROM PUBLIC;

-- Least-privilege role: insert, read the authority rows the claim re-checks, and advance status only.
CREATE ROLE farm_integration_delivery NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_integration_delivery;
GRANT SELECT ON farm.integration_envelopes, farm.integration_apps, farm.integration_app_grants TO farm_integration_delivery;
GRANT SELECT (id, sandbox) ON farm.farms TO farm_integration_delivery;
GRANT SELECT (id, farm_id, agent_id, revoked_at) ON farm.printer_assignments TO farm_integration_delivery;
GRANT INSERT ON farm.integration_envelopes TO farm_integration_delivery;
GRANT UPDATE (status, refusal_code, result_detail, history_entry_id, updated_at) ON farm.integration_envelopes TO farm_integration_delivery;
