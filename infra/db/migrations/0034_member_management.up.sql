-- Owner member management: invites gain a terminal revocation, and the registration
-- role may change a membership role, tombstone it and revoke an invite.
ALTER TABLE farm.account_invites
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by text REFERENCES farm.session_accounts(id),
  ADD CONSTRAINT account_invites_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  ADD CONSTRAINT account_invites_single_outcome CHECK (revoked_at IS NULL OR consumed_at IS NULL);
CREATE OR REPLACE FUNCTION farm.account_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.farm_id <> OLD.farm_id OR NEW.role <> OLD.role
     OR NEW.digest <> OLD.digest OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Invitations are immutable except for one consumption or revocation';
  END IF;
  RETURN NEW;
END;
$$;
GRANT UPDATE (revoked_at, revoked_by) ON farm.account_invites TO farm_account_registration;
GRANT UPDATE (role, revoked_at) ON farm.memberships TO farm_account_registration;
