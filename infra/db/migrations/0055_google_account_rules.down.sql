DROP TABLE farm.sign_in_rules;
CREATE OR REPLACE FUNCTION farm.account_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.farm_id <> OLD.farm_id OR NEW.role <> OLD.role
     OR NEW.digest <> OLD.digest OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'Invitations immutable except one consumption or revocation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE farm.account_invites DROP COLUMN bound_email;
