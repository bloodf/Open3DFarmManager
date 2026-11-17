REVOKE INSERT ON farm.oidc_identities FROM farm_account_registration;
REVOKE SELECT ON farm.oidc_identities FROM farm_password_auth;
DROP TRIGGER oidc_identity_no_truncate ON farm.oidc_identities;
DROP TRIGGER oidc_identity_guard ON farm.oidc_identities;
DROP FUNCTION farm.oidc_identity_guard();
DROP TABLE farm.oidc_identities;
