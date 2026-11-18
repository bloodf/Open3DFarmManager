REVOKE UPDATE (id) ON farm.session_accounts FROM farm_spoolman_settings;
REVOKE UPDATE (last_seen_at, revoked_at) ON farm.account_sessions FROM farm_spoolman_settings;
REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_spoolman_settings;
REVOKE UPDATE (agent_id) ON farm.connector_enrollments FROM farm_spoolman_settings;
REVOKE ALL PRIVILEGES ON farm.spoolman_connector_settings, farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments FROM farm_spoolman_settings;
REVOKE USAGE ON SCHEMA farm FROM farm_spoolman_settings;
DROP ROLE farm_spoolman_settings;
DROP TABLE farm.spoolman_connector_settings;
