CREATE TABLE farm.password_reset_tokens (
  account_id text PRIMARY KEY REFERENCES farm.password_credentials(account_id),
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[a-f0-9]{64}$'),
  credential_version bigint NOT NULL CHECK (credential_version BETWEEN 0 AND 9007199254740991),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes')
);
CREATE ROLE farm_password_reset NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_password_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON farm.password_reset_tokens TO farm_password_reset;
GRANT UPDATE (password_hash) ON farm.password_credentials TO farm_password_reset;
