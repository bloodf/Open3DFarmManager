-- Farm-scoped spool library storage (built-in Spoolman-compatible inventory).
-- Every row carries farm_id and every reference is composite (farm_id, id), so
-- a row can never point at another farm's vendor, filament or spool. Spoolman
-- clients address records by small integers; ids are allocated per farm.
-- Legacy unauthenticated clients (for example Moonraker) get a per-farm
-- credential that appears in their server URL. Only a SHA-256 of its random
-- secret is stored. Expand-only: no existing table or column is changed.
CREATE TABLE farm.spool_library_counters (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  kind text NOT NULL CHECK (kind IN ('vendor', 'filament', 'spool')),
  last_id bigint NOT NULL CHECK (last_id BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, kind)
);

CREATE TABLE farm.spool_vendors (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id bigint NOT NULL CHECK (id >= 1),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 256),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1024),
  external_id text CHECK (external_id IS NULL OR char_length(external_id) <= 256),
  extra jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 65536),
  registered_at bigint NOT NULL CHECK (registered_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, id)
);

CREATE TABLE farm.spool_filaments (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id bigint NOT NULL CHECK (id >= 1),
  vendor_id bigint,
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 256),
  material text CHECK (material IS NULL OR char_length(material) BETWEEN 1 AND 64),
  color_hex text CHECK (color_hex IS NULL OR color_hex ~ '^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$'),
  density double precision NOT NULL CHECK (density > 0),
  diameter double precision NOT NULL CHECK (diameter > 0),
  weight double precision CHECK (weight IS NULL OR weight > 0),
  spool_weight double precision CHECK (spool_weight IS NULL OR spool_weight >= 0),
  price double precision CHECK (price IS NULL OR price >= 0),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1024),
  external_id text CHECK (external_id IS NULL OR char_length(external_id) <= 256),
  extra jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 65536),
  registered_at bigint NOT NULL CHECK (registered_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, id),
  FOREIGN KEY (farm_id, vendor_id) REFERENCES farm.spool_vendors (farm_id, id)
);
CREATE INDEX spool_filaments_vendor ON farm.spool_filaments (farm_id, vendor_id);

CREATE TABLE farm.spools (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id bigint NOT NULL CHECK (id >= 1),
  filament_id bigint NOT NULL,
  initial_weight double precision CHECK (initial_weight IS NULL OR initial_weight >= 0),
  spool_weight double precision CHECK (spool_weight IS NULL OR spool_weight >= 0),
  used_weight double precision NOT NULL DEFAULT 0 CHECK (used_weight >= 0),
  price double precision CHECK (price IS NULL OR price >= 0),
  location text CHECK (location IS NULL OR char_length(location) <= 256),
  lot_nr text CHECK (lot_nr IS NULL OR char_length(lot_nr) <= 256),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 1024),
  archived boolean NOT NULL DEFAULT false,
  extra jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 65536),
  registered_at bigint NOT NULL CHECK (registered_at BETWEEN 0 AND 9007199254740991),
  first_used_at bigint CHECK (first_used_at BETWEEN 0 AND 9007199254740991),
  last_used_at bigint CHECK (last_used_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, id),
  FOREIGN KEY (farm_id, filament_id) REFERENCES farm.spool_filaments (farm_id, id)
);
CREATE INDEX spools_filament ON farm.spools (farm_id, filament_id);

-- Per-farm credential for legacy clients that cannot authenticate. The
-- credential id is public (it is in the URL); secret_sha256 is the only trace
-- of the secret. access 'read' never mutates.
CREATE TABLE farm.spool_library_credentials (
  id uuid PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64 AND label = btrim(label)),
  access text NOT NULL CHECK (access IN ('read', 'write')),
  secret_sha256 text NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  last_used_at bigint CHECK (last_used_at BETWEEN 0 AND 9007199254740991),
  revoked_at bigint CHECK (revoked_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (farm_id, id)
);
CREATE INDEX spool_library_credentials_farm ON farm.spool_library_credentials (farm_id, created_at);

CREATE ROLE farm_spool_library NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_spool_library;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships TO farm_spool_library;
GRANT UPDATE (id) ON farm.session_accounts TO farm_spool_library;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_spool_library;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_spool_library;
-- Column-level UPDATE: the role can never re-home a row (farm_id, id, registered_at stay fixed).
GRANT SELECT, INSERT, DELETE ON farm.spool_vendors, farm.spool_filaments, farm.spools TO farm_spool_library;
GRANT UPDATE (name, comment, external_id, extra) ON farm.spool_vendors TO farm_spool_library;
GRANT UPDATE (vendor_id, name, material, color_hex, density, diameter, weight, spool_weight, price, comment, external_id, extra) ON farm.spool_filaments TO farm_spool_library;
GRANT UPDATE (filament_id, initial_weight, spool_weight, used_weight, price, location, lot_nr, comment, archived, extra, first_used_at, last_used_at) ON farm.spools TO farm_spool_library;
GRANT SELECT, INSERT ON farm.spool_library_counters TO farm_spool_library;
GRANT UPDATE (last_id) ON farm.spool_library_counters TO farm_spool_library;
GRANT SELECT, INSERT ON farm.spool_library_credentials TO farm_spool_library;
GRANT UPDATE (last_used_at, revoked_at) ON farm.spool_library_credentials TO farm_spool_library;
