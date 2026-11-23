-- Installation-level sign-in provider settings. The client secret is stored only
-- as application-encrypted ciphertext; plaintext never leaves the app layer.
CREATE TABLE farm.sign_in_providers (
  id text PRIMARY KEY CHECK (id IN ('google')),
  enabled boolean NOT NULL DEFAULT false,
  client_id text NOT NULL DEFAULT '' CHECK (char_length(client_id) <= 200),
  client_secret_ciphertext bytea,
  client_secret_nonce bytea,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text REFERENCES farm.session_accounts(id),
  CHECK (
    (client_secret_ciphertext IS NULL) = (client_secret_nonce IS NULL)
    AND (
      client_secret_ciphertext IS NULL
      OR (
        octet_length(client_secret_ciphertext) BETWEEN 16 AND 1024
        AND octet_length(client_secret_nonce) = 12
      )
    )
  )
);
INSERT INTO farm.sign_in_providers (id) VALUES ('google');
GRANT SELECT, INSERT, UPDATE ON farm.sign_in_providers TO farm_account_registration;
