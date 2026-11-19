ALTER TABLE farm.account_invites ADD COLUMN bound_email text CHECK (bound_email IS NULL OR (length(bound_email) BETWEEN 3 AND 254 AND bound_email = lower(bound_email) AND bound_email !~ '[[:space:]]'));
CREATE OR REPLACE FUNCTION farm.account_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.farm_id <> OLD.farm_id OR NEW.role <> OLD.role
     OR NEW.digest <> OLD.digest OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR NEW.bound_email IS DISTINCT FROM OLD.bound_email THEN
    RAISE EXCEPTION 'Invitations immutable except one consumption or revocation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TABLE farm.sign_in_rules (
  farm_id uuid PRIMARY KEY REFERENCES farm.farms(id),
  mode text NOT NULL CHECK (mode IN ('link-only', 'invite-only', 'allowed-domains')),
  allowed_domains text[] NOT NULL DEFAULT '{}',
  CHECK (cardinality(allowed_domains) <= 100)
);
GRANT SELECT, INSERT, UPDATE ON farm.sign_in_rules TO farm_account_registration;
