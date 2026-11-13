CREATE TABLE farm.configuration_operations (
  operation_id uuid PRIMARY KEY,
  record jsonb NOT NULL CHECK (octet_length(record::text) <= 8192)
);
CREATE TABLE farm.configuration_challenges (
  challenge_id uuid PRIMARY KEY,
  capability_id uuid NOT NULL UNIQUE,
  admission_nonce text NOT NULL UNIQUE,
  record jsonb NOT NULL CHECK (octet_length(record::text) <= 16384),
  consumed boolean NOT NULL DEFAULT false
);
CREATE TABLE farm.configuration_receipts (
  operation_id uuid PRIMARY KEY REFERENCES farm.configuration_operations(operation_id),
  receipt_sha256 text NOT NULL,
  assignment_id uuid NOT NULL UNIQUE REFERENCES farm.printer_assignments(id),
  record jsonb NOT NULL CHECK (octet_length(record::text) <= 16384)
);
CREATE ROLE farm_configuration_authority NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_configuration_authority;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.browser_device_keys, farm.connector_enrollments, farm.connector_credentials, farm.connector_credential_proofs, farm.connector_revocations, farm.printer_assignments TO farm_configuration_authority;
GRANT UPDATE(id) ON farm.session_accounts TO farm_configuration_authority;
GRANT UPDATE(last_seen_at) ON farm.account_sessions TO farm_configuration_authority;
GRANT UPDATE(farm_id) ON farm.memberships TO farm_configuration_authority;
GRANT UPDATE(key_id) ON farm.browser_device_keys TO farm_configuration_authority;
GRANT UPDATE(agent_id) ON farm.connector_enrollments, farm.connector_credentials TO farm_configuration_authority;
GRANT UPDATE(jti) ON farm.connector_credential_proofs TO farm_configuration_authority;
GRANT EXECUTE ON FUNCTION farm.observe_signalling_session_expiry(text) TO farm_configuration_authority;
GRANT SELECT,INSERT ON farm.configuration_operations, farm.configuration_challenges, farm.configuration_receipts TO farm_configuration_authority;
GRANT UPDATE(record) ON farm.configuration_operations TO farm_configuration_authority;
GRANT UPDATE(consumed) ON farm.configuration_challenges TO farm_configuration_authority;
GRANT INSERT ON farm.printer_assignments TO farm_configuration_authority;
