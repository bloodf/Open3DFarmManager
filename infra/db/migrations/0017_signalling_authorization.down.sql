-- Session expiry tombstones belong to the maintained session store and remain intact.
DROP FUNCTION farm.observe_signalling_session_expiry(text);
REVOKE ALL ON farm.session_accounts, farm.account_sessions, farm.memberships,
  farm.browser_device_keys, farm.connector_enrollments, farm.connector_credentials,
  farm.connector_revocations FROM farm_signalling_reader;
REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_signalling_reader;
REVOKE UPDATE (key_id) ON farm.browser_device_keys FROM farm_signalling_reader;
REVOKE UPDATE (agent_id) ON farm.connector_enrollments FROM farm_signalling_reader;
REVOKE UPDATE (jti) ON farm.connector_credentials FROM farm_signalling_reader;
REVOKE USAGE ON SCHEMA farm FROM farm_signalling_reader;
DROP ROLE farm_signalling_reader;

REVOKE SELECT ON farm.session_accounts, farm.account_sessions FROM farm_signalling_expiry_owner;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_signalling_expiry_owner;
REVOKE UPDATE (revoked_at) ON farm.account_sessions FROM farm_signalling_expiry_owner;
REVOKE USAGE ON SCHEMA farm FROM farm_signalling_expiry_owner;
DROP ROLE farm_signalling_expiry_owner;
