REVOKE UPDATE (role, revoked_at) ON farm.memberships FROM farm_account_registration;
REVOKE UPDATE (revoked_at, revoked_by) ON farm.account_invites FROM farm_account_registration;
CREATE OR REPLACE FUNCTION farm.account_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
-- The older schema has no revocation. Spend revoked invites so none becomes usable again.
UPDATE farm.account_invites SET consumed_at = revoked_at, consumed_by = revoked_by, revoked_at = NULL, revoked_by = NULL
  WHERE revoked_at IS NOT NULL;
ALTER TABLE farm.account_invites DROP COLUMN revoked_at, DROP COLUMN revoked_by;
