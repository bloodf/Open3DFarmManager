CREATE TABLE farm.printer_assignments (
  id uuid PRIMARY KEY,
  farm_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES farm.connector_enrollments(agent_id),
  printer_key text COLLATE "C" NOT NULL CHECK (length(printer_key) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  created_by text NOT NULL REFERENCES farm.session_accounts(id),
  revoked_at bigint CHECK (revoked_at BETWEEN created_at AND 9007199254740991),
  revoked_by text REFERENCES farm.session_accounts(id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX printer_assignments_active_key ON farm.printer_assignments (farm_id, printer_key) WHERE revoked_at IS NULL;
CREATE INDEX printer_assignments_active_agent ON farm.printer_assignments (agent_id) WHERE revoked_at IS NULL;
CREATE FUNCTION farm.printer_assignment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM farm.connector_enrollments WHERE agent_id = NEW.agent_id AND farm_id = NEW.farm_id AND status = 'approved') THEN
      RAISE EXCEPTION 'Assignment requires approved enrollment';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
    (NEW.id, NEW.farm_id, NEW.agent_id, NEW.printer_key, NEW.created_at, NEW.created_by) IS DISTINCT FROM
    (OLD.id, OLD.farm_id, OLD.agent_id, OLD.printer_key, OLD.created_at, OLD.created_by)
  THEN RAISE EXCEPTION 'Assignment identity and tombstones are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER printer_assignment_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.printer_assignments FOR EACH ROW EXECUTE FUNCTION farm.printer_assignment_lifecycle();
CREATE TRIGGER printer_assignment_no_truncate BEFORE TRUNCATE ON farm.printer_assignments FOR EACH STATEMENT EXECUTE FUNCTION farm.printer_assignment_lifecycle();
CREATE ROLE farm_printer_ownership NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_printer_ownership;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments, farm.printer_assignments TO farm_printer_ownership;
GRANT UPDATE (id) ON farm.session_accounts TO farm_printer_ownership;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_printer_ownership;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_printer_ownership;
GRANT UPDATE (agent_id) ON farm.connector_enrollments TO farm_printer_ownership;
GRANT INSERT ON farm.printer_assignments TO farm_printer_ownership;
GRANT UPDATE (revoked_at, revoked_by) ON farm.printer_assignments TO farm_printer_ownership;
