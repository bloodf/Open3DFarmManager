DROP TABLE farm.pairing_requests;
DROP FUNCTION farm.pairing_lifecycle();
REVOKE ALL ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments FROM farm_pairing_runtime;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_pairing_runtime;
REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_pairing_runtime;
REVOKE UPDATE (last_seen_at, revoked_at) ON farm.account_sessions FROM farm_pairing_runtime;
REVOKE INSERT (agent_id, farm_id, public_key_spki, fingerprint), UPDATE (status) ON farm.connector_enrollments FROM farm_pairing_runtime;
REVOKE USAGE ON SCHEMA farm FROM farm_pairing_runtime;
DROP ROLE farm_pairing_runtime;
