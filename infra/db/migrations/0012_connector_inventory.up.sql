-- Independent read-only inventory capability. No credential or pairing-code access.
CREATE ROLE farm_connector_inventory NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_connector_inventory;
GRANT SELECT (id, session_version, disabled) ON farm.session_accounts TO farm_connector_inventory;
GRANT SELECT (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at, revoked_at) ON farm.account_sessions TO farm_connector_inventory;
GRANT SELECT (farm_id, account_id, revoked_at) ON farm.memberships TO farm_connector_inventory;
GRANT SELECT (agent_id, farm_id, fingerprint, status) ON farm.connector_enrollments TO farm_connector_inventory;
-- Row locks require UPDATE on one column. Existing identity guards reject changes.
GRANT UPDATE (id) ON farm.session_accounts TO farm_connector_inventory;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_connector_inventory;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_connector_inventory;
CREATE INDEX memberships_inventory_account_farm ON farm.memberships (account_id, farm_id) WHERE revoked_at IS NULL;
CREATE INDEX connector_inventory_farm_agent ON farm.connector_enrollments (farm_id, agent_id);
