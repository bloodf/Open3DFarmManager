-- Import of existing spool libraries (Spoolman API, JSON, CSV) into the
-- farm-scoped library from migration 0085. Expand-only: no existing table,
-- column or grant is changed.
--
-- Stable source identities make repeated imports idempotent: an upstream record
-- is addressed by (farm, source key, kind, upstream id) and maps to exactly one
-- local record. Fields and settings are stored per farm. The import role is
-- separate from farm_spool_library and never holds DELETE.
CREATE TABLE farm.spool_import_runs (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id uuid NOT NULL,
  source_key text NOT NULL CHECK (source_key ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  format text NOT NULL CHECK (format IN ('spoolman-api', 'json', 'csv')),
  status text NOT NULL CHECK (status IN ('completed', 'dry-run', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z-]{1,40}$'),
  counts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object' AND pg_column_size(counts) <= 16384),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 128),
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, id)
);
CREATE INDEX spool_import_runs_recent ON farm.spool_import_runs (farm_id, started_at);

-- One row per upstream record. Exactly one local reference is set, matching kind;
-- deleting the local record removes the identity (a later import recreates it).
-- applied_sha256 is the hash of the local record as the import left it, so a
-- later import can tell a local edit from an unchanged record.
CREATE TABLE farm.spool_import_identities (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  source_key text NOT NULL CHECK (source_key ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  kind text NOT NULL CHECK (kind IN ('vendor', 'filament', 'spool')),
  upstream_id text NOT NULL CHECK (upstream_id ~ '^[0-9]{1,15}$'),
  vendor_id bigint,
  filament_id bigint,
  spool_id bigint,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  applied_sha256 text NOT NULL CHECK (applied_sha256 ~ '^[0-9a-f]{64}$'),
  first_run_id uuid NOT NULL,
  updated_run_id uuid NOT NULL,
  PRIMARY KEY (farm_id, source_key, kind, upstream_id),
  CHECK ((kind = 'vendor') = (vendor_id IS NOT NULL) AND (kind = 'filament') = (filament_id IS NOT NULL) AND (kind = 'spool') = (spool_id IS NOT NULL)),
  FOREIGN KEY (farm_id, vendor_id) REFERENCES farm.spool_vendors (farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, filament_id) REFERENCES farm.spool_filaments (farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, first_run_id) REFERENCES farm.spool_import_runs (farm_id, id),
  FOREIGN KEY (farm_id, updated_run_id) REFERENCES farm.spool_import_runs (farm_id, id)
);
-- A local record belongs to at most one upstream identity.
CREATE UNIQUE INDEX spool_import_identities_vendor ON farm.spool_import_identities (farm_id, vendor_id) WHERE vendor_id IS NOT NULL;
CREATE UNIQUE INDEX spool_import_identities_filament ON farm.spool_import_identities (farm_id, filament_id) WHERE filament_id IS NOT NULL;
CREATE UNIQUE INDEX spool_import_identities_spool ON farm.spool_import_identities (farm_id, spool_id) WHERE spool_id IS NOT NULL;

-- Extra-field definitions (Spoolman "fields"), one per entity kind and key.
CREATE TABLE farm.spool_library_fields (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  entity_type text NOT NULL CHECK (entity_type IN ('vendor', 'filament', 'spool')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  field_type text NOT NULL CHECK (field_type IN ('text', 'integer', 'integer_range', 'float', 'float_range', 'datetime', 'boolean', 'choice')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 32),
  default_value text CHECK (default_value IS NULL OR char_length(default_value) <= 1024),
  choices jsonb CHECK (choices IS NULL OR (jsonb_typeof(choices) = 'array' AND pg_column_size(choices) <= 16384)),
  multi_choice boolean NOT NULL DEFAULT false,
  source_key text NOT NULL CHECK (source_key ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, entity_type, key)
);

-- Library settings (Spoolman "settings"), values are JSON.
CREATE TABLE farm.spool_library_settings (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
  value jsonb NOT NULL CHECK (pg_column_size(value) <= 65536),
  source_key text NOT NULL CHECK (source_key ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, key)
);

CREATE ROLE farm_spool_import NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_spool_import;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships TO farm_spool_import;
-- Row locks (FOR SHARE / FOR UPDATE) need a column UPDATE privilege; no value is ever written to these columns.
GRANT UPDATE (id) ON farm.session_accounts TO farm_spool_import;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_spool_import;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_spool_import;
-- Inserts and column-level updates only: the import cannot delete or re-home a row.
GRANT SELECT, INSERT ON farm.spool_vendors, farm.spool_filaments, farm.spools TO farm_spool_import;
GRANT UPDATE (name, comment, external_id, extra) ON farm.spool_vendors TO farm_spool_import;
GRANT UPDATE (vendor_id, name, material, color_hex, density, diameter, weight, spool_weight, price, comment, external_id, extra) ON farm.spool_filaments TO farm_spool_import;
GRANT UPDATE (filament_id, initial_weight, spool_weight, used_weight, price, location, lot_nr, comment, archived, extra, first_used_at, last_used_at) ON farm.spools TO farm_spool_import;
GRANT SELECT, INSERT ON farm.spool_library_counters TO farm_spool_import;
GRANT UPDATE (last_id) ON farm.spool_library_counters TO farm_spool_import;
GRANT SELECT, INSERT ON farm.spool_import_runs, farm.spool_import_identities, farm.spool_library_fields, farm.spool_library_settings TO farm_spool_import;
GRANT UPDATE (source_sha256, applied_sha256, updated_run_id) ON farm.spool_import_identities TO farm_spool_import;
GRANT UPDATE (name, field_type, sort_order, unit, default_value, choices, multi_choice, source_key, source_sha256, updated_at) ON farm.spool_library_fields TO farm_spool_import;
GRANT UPDATE (value, source_key, source_sha256, updated_at) ON farm.spool_library_settings TO farm_spool_import;
GRANT UPDATE (status, error_code, counts) ON farm.spool_import_runs TO farm_spool_import;
