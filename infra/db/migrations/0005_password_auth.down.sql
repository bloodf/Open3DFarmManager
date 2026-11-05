DROP TABLE farm.auth_rate_limits;
DROP TABLE farm.password_credentials;
DROP FUNCTION farm.password_credential_guard();
REVOKE INSERT ON farm.account_sessions FROM farm_password_auth;
REVOKE USAGE ON SCHEMA farm FROM farm_password_auth;
DROP ROLE farm_password_auth;
