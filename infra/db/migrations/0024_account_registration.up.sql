-- Farm-owner invitations. Only a SHA-256 digest of the single-use token is stored.
CREATE TABLE farm.account_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL REFERENCES farm.session_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text REFERENCES farm.session_accounts(id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK ((consumed_at IS NULL) = (consumed_by IS NULL))
);
CREATE INDEX account_invites_farm_id ON farm.account_invites(farm_id);
CREATE FUNCTION farm.account_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.consumed_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.farm_id <> OLD.farm_id OR NEW.role <> OLD.role
     OR NEW.digest <> OLD.digest OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Invitations are immutable except for one consumption';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_invite_guard BEFORE UPDATE OR DELETE ON farm.account_invites
  FOR EACH ROW EXECUTE FUNCTION farm.account_invite_guard();
CREATE TRIGGER account_invite_no_truncate BEFORE TRUNCATE ON farm.account_invites
  FOR EACH STATEMENT EXECUTE FUNCTION farm.account_invite_guard();
CREATE ROLE farm_account_registration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_password_auth;
GRANT SELECT, INSERT ON farm.session_accounts, farm.password_credentials, farm.farms, farm.memberships TO farm_account_registration;
GRANT SELECT, INSERT ON farm.account_invites TO farm_account_registration;
GRANT UPDATE (consumed_at, consumed_by) ON farm.account_invites TO farm_account_registration;
-- Row locks need UPDATE on one column; existing guards reject identity changes.
GRANT UPDATE (farm_id) ON farm.memberships TO farm_account_registration;
GRANT UPDATE (id) ON farm.session_accounts TO farm_account_registration;
