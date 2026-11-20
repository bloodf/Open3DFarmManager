-- One Bambu cloud account per farm. The access and refresh tokens are stored
-- only as application-encrypted ciphertext and are never selected by reads.
CREATE TABLE farm.bambu_cloud_accounts (
  farm_id uuid PRIMARY KEY REFERENCES farm.farms(id),
  region text NOT NULL CHECK (region IN ('global', 'china')),
  account_name text NOT NULL CHECK (
    char_length(account_name) BETWEEN 3 AND 320
    AND account_name !~ '[[:cntrl:]]'
    AND account_name !~ '[[:space:]]'
  ),
  access_ciphertext bytea NOT NULL CHECK (octet_length(access_ciphertext) BETWEEN 16 AND 8192),
  access_nonce bytea NOT NULL CHECK (octet_length(access_nonce) = 12),
  refresh_ciphertext bytea CHECK (
    refresh_ciphertext IS NULL OR octet_length(refresh_ciphertext) BETWEEN 16 AND 8192
  ),
  refresh_nonce bytea,
  expires_at timestamptz NOT NULL,
  cloud_origin text CHECK (
    cloud_origin IS NULL
    OR (
      char_length(cloud_origin) <= 128
      AND cloud_origin ~ '^https?://(127\.0\.0\.1|localhost|\[[0-9a-fA-F:]+\])(:[0-9]{1,5})?$'
    )
  ),
  mqtt_host text CHECK (mqtt_host IS NULL OR mqtt_host IN ('127.0.0.1', 'localhost')),
  mqtt_port integer CHECK (mqtt_port IS NULL OR mqtt_port BETWEEN 1 AND 65535),
  mqtt_username text CHECK (
    mqtt_username IS NULL OR char_length(mqtt_username) BETWEEN 1 AND 128
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL REFERENCES farm.session_accounts(id),
  CHECK ((refresh_ciphertext IS NULL) = (refresh_nonce IS NULL)),
  CHECK ((mqtt_host IS NULL) = (mqtt_port IS NULL))
);
CREATE ROLE farm_bambu_cloud NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_bambu_cloud;
GRANT SELECT ON farm.memberships TO farm_bambu_cloud;
-- Row locks require UPDATE on one column. Membership guards reject identity changes.
GRANT UPDATE (farm_id) ON farm.memberships TO farm_bambu_cloud;
GRANT SELECT, INSERT, UPDATE, DELETE ON farm.bambu_cloud_accounts TO farm_bambu_cloud;
