-- Members may link or unlink OpenID identities through reviewed functions.
-- Direct UPDATE and DELETE on the table stay blocked; DELETE is allowed only inside unlink_oidc_identity.

DROP TRIGGER oidc_identity_guard ON farm.oidc_identities;
CREATE TRIGGER oidc_identity_immutable BEFORE UPDATE ON farm.oidc_identities
  FOR EACH ROW EXECUTE FUNCTION farm.oidc_identity_guard();

CREATE FUNCTION farm.link_oidc_identity(
  target_account_id text,
  issuer text,
  subject text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
BEGIN
  IF target_account_id IS NULL OR length(target_account_id) < 1 THEN
    RAISE EXCEPTION 'oidc_link_rejected' USING ERRCODE = '22023';
  END IF;
  IF issuer IS NULL OR issuer !~ '^https://[^[:space:]]{1,500}$' OR length(issuer) NOT BETWEEN 8 AND 512 THEN
    RAISE EXCEPTION 'oidc_link_rejected' USING ERRCODE = '22023';
  END IF;
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 256 OR subject ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'oidc_link_rejected' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM farm.session_accounts WHERE id = target_account_id AND NOT disabled FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oidc_account_unavailable' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM farm.oidc_identities i
    WHERE i.issuer = link_oidc_identity.issuer AND i.subject = link_oidc_identity.subject;
  IF FOUND THEN
    RAISE EXCEPTION 'oidc_subject_taken' USING ERRCODE = '23505';
  END IF;
  PERFORM 1 FROM farm.oidc_identities i
    WHERE i.account_id = target_account_id AND i.issuer = link_oidc_identity.issuer;
  IF FOUND THEN
    RAISE EXCEPTION 'oidc_issuer_linked' USING ERRCODE = '23505';
  END IF;
  INSERT INTO farm.oidc_identities (issuer, subject, account_id)
    VALUES (issuer, subject, target_account_id);
END;
$$;

CREATE FUNCTION farm.unlink_oidc_identity(
  target_account_id text,
  issuer text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  identity_count integer;
  has_password boolean;
BEGIN
  IF target_account_id IS NULL OR length(target_account_id) < 1 THEN
    RAISE EXCEPTION 'oidc_unlink_rejected' USING ERRCODE = '22023';
  END IF;
  IF issuer IS NULL OR issuer !~ '^https://[^[:space:]]{1,500}$' OR length(issuer) NOT BETWEEN 8 AND 512 THEN
    RAISE EXCEPTION 'oidc_unlink_rejected' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM farm.session_accounts WHERE id = target_account_id AND NOT disabled FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oidc_account_unavailable' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM farm.oidc_identities i
      WHERE i.account_id = target_account_id AND i.issuer = unlink_oidc_identity.issuer
  ) THEN
    RAISE EXCEPTION 'oidc_not_linked' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer INTO identity_count
    FROM farm.oidc_identities i
    WHERE i.account_id = target_account_id;
  SELECT EXISTS (
    SELECT 1 FROM farm.password_credentials c WHERE c.account_id = target_account_id
  ) INTO has_password;
  IF NOT has_password AND identity_count < 2 THEN
    RAISE EXCEPTION 'oidc_last_sign_in_method' USING ERRCODE = '22023';
  END IF;
  DELETE FROM farm.oidc_identities i
    WHERE i.account_id = target_account_id AND i.issuer = unlink_oidc_identity.issuer;
END;
$$;

REVOKE ALL ON FUNCTION farm.link_oidc_identity(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION farm.unlink_oidc_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.link_oidc_identity(text, text, text) TO farm_password_auth;
GRANT EXECUTE ON FUNCTION farm.unlink_oidc_identity(text, text) TO farm_password_auth;