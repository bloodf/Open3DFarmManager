DROP TABLE farm.account_sessions;
DROP TABLE farm.session_accounts;
DROP FUNCTION farm.session_state_guard();
REVOKE USAGE ON SCHEMA farm FROM farm_session_runtime;
DROP ROLE farm_session_runtime;
