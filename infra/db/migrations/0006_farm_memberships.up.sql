CREATE TABLE farm.farms (id uuid PRIMARY KEY);
CREATE TABLE farm.memberships (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  account_id text NOT NULL REFERENCES farm.session_accounts(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  revoked_at bigint CHECK (revoked_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, account_id)
);
CREATE FUNCTION farm.membership_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Membership tombstones must be retained';
  END IF;
  IF NEW.farm_id <> OLD.farm_id OR NEW.account_id <> OLD.account_id
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.role <> OLD.role)) THEN
    RAISE EXCEPTION 'Membership identity and revocation are terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER membership_lifecycle BEFORE UPDATE OR DELETE ON farm.memberships
  FOR EACH ROW EXECUTE FUNCTION farm.membership_lifecycle();
CREATE TRIGGER membership_no_truncate BEFORE TRUNCATE ON farm.memberships
  FOR EACH STATEMENT EXECUTE FUNCTION farm.membership_lifecycle();
CREATE ROLE farm_enrollment_approver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_enrollment_approver;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments TO farm_enrollment_approver;
-- PostgreSQL row locks require UPDATE on one column. Existing guards reject identity changes.
GRANT UPDATE (id) ON farm.session_accounts TO farm_enrollment_approver;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_enrollment_approver;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_enrollment_approver;
GRANT UPDATE (status) ON farm.connector_enrollments TO farm_enrollment_approver;
