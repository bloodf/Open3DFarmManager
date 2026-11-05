DROP INDEX farm.connector_inventory_farm_agent;
DROP INDEX farm.memberships_inventory_account_farm;
REVOKE ALL ON farm.connector_enrollments, farm.memberships, farm.account_sessions, farm.session_accounts FROM farm_connector_inventory;
REVOKE SELECT (id, session_version, disabled), UPDATE (id) ON farm.session_accounts FROM farm_connector_inventory;
REVOKE SELECT (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at, revoked_at), UPDATE (last_seen_at) ON farm.account_sessions FROM farm_connector_inventory;
REVOKE SELECT (farm_id, account_id, revoked_at), UPDATE (farm_id) ON farm.memberships FROM farm_connector_inventory;
REVOKE SELECT (agent_id, farm_id, fingerprint, status) ON farm.connector_enrollments FROM farm_connector_inventory;
REVOKE USAGE ON SCHEMA farm FROM farm_connector_inventory;
DROP ROLE farm_connector_inventory;
