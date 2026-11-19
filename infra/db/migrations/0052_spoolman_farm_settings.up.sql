-- Non-secret Spoolman setting per farm Connector. Credentials are kept only in
-- the Connector private configuration and never reach this table.
CREATE TABLE farm.spoolman_connector_settings (
  farm_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin ~ '^https?://[^/?#@ ]+$' AND char_length(origin) <= 256),
  status text NOT NULL CHECK (status IN ('reachable', 'unreachable', 'unauthorized')),
  configured boolean NOT NULL,
  checked_at bigint NOT NULL CHECK (checked_at BETWEEN 0 AND 9007199254740991),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY (farm_id, agent_id)
);
CREATE ROLE farm_spoolman_settings NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_spoolman_settings;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments TO farm_spoolman_settings;
GRANT UPDATE (id) ON farm.session_accounts TO farm_spoolman_settings;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_spoolman_settings;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_spoolman_settings;
GRANT UPDATE (agent_id) ON farm.connector_enrollments TO farm_spoolman_settings;
GRANT SELECT, INSERT, UPDATE ON farm.spoolman_connector_settings TO farm_spoolman_settings;
