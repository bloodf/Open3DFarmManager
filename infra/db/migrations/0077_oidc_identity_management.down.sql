REVOKE EXECUTE ON FUNCTION farm.unlink_oidc_identity(text, text) FROM farm_password_auth;
REVOKE EXECUTE ON FUNCTION farm.link_oidc_identity(text, text, text) FROM farm_password_auth;
DROP FUNCTION farm.unlink_oidc_identity(text, text);
DROP FUNCTION farm.link_oidc_identity(text, text, text);
DROP TRIGGER oidc_identity_immutable ON farm.oidc_identities;
CREATE TRIGGER oidc_identity_guard BEFORE UPDATE OR DELETE ON farm.oidc_identities
  FOR EACH ROW EXECUTE FUNCTION farm.oidc_identity_guard();