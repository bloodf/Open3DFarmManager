DROP TABLE farm.connector_revocations;
DROP FUNCTION farm.connector_revocation_lifecycle();
REVOKE ALL ON farm.session_accounts, farm.account_sessions, farm.memberships,
  farm.pairing_requests, farm.connector_enrollments, farm.connector_credentials FROM farm_connector_revoker;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_connector_revoker;
REVOKE UPDATE (last_seen_at, revoked_at) ON farm.account_sessions FROM farm_connector_revoker;
REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_connector_revoker;
REVOKE UPDATE (agent_id) ON farm.pairing_requests FROM farm_connector_revoker;
REVOKE UPDATE (status) ON farm.connector_enrollments FROM farm_connector_revoker;
REVOKE UPDATE (jti) ON farm.connector_credentials FROM farm_connector_revoker;
REVOKE USAGE ON SCHEMA farm FROM farm_connector_revoker;
DROP ROLE farm_connector_revoker;
