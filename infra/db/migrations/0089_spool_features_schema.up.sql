-- Farm-scoped spool library schema for auxiliary Spoolman APIs (#545) and
-- farm features (#543): direct API writes for settings and custom fields,
-- locations, per-farm currency and low-stock thresholds, printer/AMS/toolhead
-- slot assignments, spool usage records, drying logs, and humidity readings.
--
-- Expand-only: every table carries farm_id, every cross-table reference is a
-- composite (farm_id, id) foreign key, and the runtime role farm_spool_features
-- holds column-level UPDATE privileges only (farm_id is never updatable).

-- Enable composite (farm_id, id) foreign keys into existing printer and job tables.
ALTER TABLE farm.printer_assignments
  ADD CONSTRAINT printer_assignments_farm_id_id_key UNIQUE (farm_id, id);

ALTER TABLE farm.job_history
  ADD CONSTRAINT job_history_farm_id_id_key UNIQUE (farm_id, id);

-- Per-filament low-stock threshold (grams); NULL falls back to farm default.
ALTER TABLE farm.spool_filaments
  ADD COLUMN low_stock_threshold_grams double precision
    CHECK (low_stock_threshold_grams IS NULL OR (low_stock_threshold_grams >= 0 AND low_stock_threshold_grams < 'Infinity'::float8));

-- Allow direct API inserts to upstream settings and extra-field definitions
-- without supplying import provenance (existing NOT NULL constraints stay intact).
ALTER TABLE farm.spool_library_settings
  ALTER COLUMN source_key SET DEFAULT 'local',
  ALTER COLUMN source_sha256 SET DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';

ALTER TABLE farm.spool_library_fields
  ALTER COLUMN source_key SET DEFAULT 'local',
  ALTER COLUMN source_sha256 SET DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';

-- Farm-scoped spool storage locations (supports listing, ordering, and rename).
CREATE TABLE farm.spool_locations (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 256 AND name = btrim(name)),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  PRIMARY KEY (farm_id, name)
);
CREATE INDEX spool_locations_farm_order ON farm.spool_locations (farm_id, sort_order, name);

-- Per-farm defaults for low-stock warnings (grams) and print cost currency (ISO-4217).
CREATE TABLE farm.spool_farm_settings (
  farm_id uuid PRIMARY KEY REFERENCES farm.farms(id),
  default_low_stock_threshold_grams double precision
    CHECK (default_low_stock_threshold_grams IS NULL OR (default_low_stock_threshold_grams >= 0 AND default_low_stock_threshold_grams < 'Infinity'::float8)),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
);

-- Spool assignments to printer, AMS, or toolhead slots.
-- Partial unique index enforces at most one active spool per slot.
CREATE TABLE farm.spool_slot_assignments (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id uuid NOT NULL,
  spool_id bigint NOT NULL,
  printer_id uuid NOT NULL,
  slot_kind text NOT NULL CHECK (slot_kind IN ('printer', 'ams', 'toolhead')),
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 0 AND 1024),
  assigned_at bigint NOT NULL CHECK (assigned_at BETWEEN 0 AND 9007199254740991),
  unassigned_at bigint CHECK (unassigned_at IS NULL OR unassigned_at BETWEEN assigned_at AND 9007199254740991),
  PRIMARY KEY (farm_id, id),
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id),
  FOREIGN KEY (farm_id, printer_id) REFERENCES farm.printer_assignments (farm_id, id)
);
CREATE UNIQUE INDEX spool_slot_assignments_active_slot
  ON farm.spool_slot_assignments (farm_id, printer_id, slot_kind, slot_index)
  WHERE unassigned_at IS NULL;
CREATE INDEX spool_slot_assignments_spool_active
  ON farm.spool_slot_assignments (farm_id, spool_id)
  WHERE unassigned_at IS NULL;
CREATE INDEX spool_slot_assignments_printer_history
  ON farm.spool_slot_assignments (farm_id, printer_id, assigned_at DESC);

-- Spool filament consumption records. Cost per print is computed as
-- COALESCE(spool.price, filament.price) / spool.initial_weight * grams.
CREATE TABLE farm.spool_usage_records (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id uuid NOT NULL,
  spool_id bigint NOT NULL,
  job_id bigint,
  printer_id uuid,
  grams double precision NOT NULL CHECK (grams >= 0 AND grams < 'Infinity'::float8),
  source text NOT NULL CHECK (source IN ('telemetry', 'manual', 'api')),
  corrected_by text CHECK (corrected_by IS NULL OR char_length(corrected_by) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, id),
  CHECK (source <> 'telemetry' OR printer_id IS NOT NULL),
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id),
  FOREIGN KEY (farm_id, printer_id) REFERENCES farm.printer_assignments (farm_id, id),
  FOREIGN KEY (farm_id, job_id) REFERENCES farm.job_history (farm_id, id)
);
CREATE INDEX spool_usage_records_spool
  ON farm.spool_usage_records (farm_id, spool_id, created_at DESC);
CREATE INDEX spool_usage_records_printer
  ON farm.spool_usage_records (farm_id, printer_id, created_at DESC)
  WHERE printer_id IS NOT NULL;
CREATE INDEX spool_usage_records_job
  ON farm.spool_usage_records (farm_id, job_id)
  WHERE job_id IS NOT NULL;

-- Spool drying sessions (ended_at is NULL while drying is in progress).
CREATE TABLE farm.spool_drying_logs (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id uuid NOT NULL,
  spool_id bigint NOT NULL,
  started_at bigint NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
  ended_at bigint CHECK (ended_at IS NULL OR ended_at BETWEEN started_at AND 9007199254740991),
  temperature_celsius double precision NOT NULL CHECK (temperature_celsius >= 0 AND temperature_celsius <= 300),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1024),
  PRIMARY KEY (farm_id, id),
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id)
);
CREATE INDEX spool_drying_logs_spool
  ON farm.spool_drying_logs (farm_id, spool_id, started_at DESC);

-- Humidity readings attached to a spool, a printer/AMS/toolhead slot, or both.
CREATE TABLE farm.spool_humidity_readings (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id uuid NOT NULL,
  spool_id bigint,
  printer_id uuid,
  slot_kind text CHECK (slot_kind IS NULL OR slot_kind IN ('printer', 'ams', 'toolhead')),
  slot_index integer CHECK (slot_index IS NULL OR slot_index BETWEEN 0 AND 1024),
  humidity_percent double precision NOT NULL CHECK (humidity_percent >= 0 AND humidity_percent <= 100),
  source text NOT NULL CHECK (source IN ('ams', 'manual')),
  recorded_at bigint NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, id),
  CHECK ((printer_id IS NULL) = (slot_kind IS NULL) AND (printer_id IS NULL) = (slot_index IS NULL)),
  CHECK (spool_id IS NOT NULL OR printer_id IS NOT NULL),
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id),
  FOREIGN KEY (farm_id, printer_id) REFERENCES farm.printer_assignments (farm_id, id)
);
CREATE INDEX spool_humidity_readings_spool
  ON farm.spool_humidity_readings (farm_id, spool_id, recorded_at DESC)
  WHERE spool_id IS NOT NULL;
CREATE INDEX spool_humidity_readings_slot
  ON farm.spool_humidity_readings (farm_id, printer_id, slot_kind, slot_index, recorded_at DESC)
  WHERE printer_id IS NOT NULL;

-- Keep farm_spool_library within its strict role policy (read-only on new
-- tables, column-level update on the existing spool_filaments table).
GRANT UPDATE (low_stock_threshold_grams) ON farm.spool_filaments TO farm_spool_library;
GRANT SELECT ON farm.spool_library_settings, farm.spool_locations, farm.spool_farm_settings TO farm_spool_library;

-- Least-privilege runtime role for auxiliary spool APIs and farm features.
CREATE ROLE farm_spool_features NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_spool_features;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships TO farm_spool_features;
GRANT UPDATE (id) ON farm.session_accounts TO farm_spool_features;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_spool_features;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_spool_features;
GRANT SELECT (id) ON farm.farms TO farm_spool_features;
GRANT SELECT (id, farm_id, agent_id, printer_key, revoked_at) ON farm.printer_assignments TO farm_spool_features;
GRANT SELECT (id, farm_id) ON farm.job_history TO farm_spool_features;
GRANT SELECT ON farm.spool_vendors, farm.spool_filaments, farm.spools TO farm_spool_features;
GRANT UPDATE (low_stock_threshold_grams) ON farm.spool_filaments TO farm_spool_features;
GRANT UPDATE (location) ON farm.spools TO farm_spool_features;
-- Column-level UPDATE only: farm_id and immutable identifiers can never change.
GRANT SELECT, INSERT, DELETE ON farm.spool_library_settings, farm.spool_library_fields, farm.spool_locations, farm.spool_drying_logs, farm.spool_humidity_readings TO farm_spool_features;
GRANT SELECT, INSERT ON farm.spool_farm_settings, farm.spool_slot_assignments, farm.spool_usage_records TO farm_spool_features;
GRANT UPDATE (value, source_key, source_sha256, updated_at) ON farm.spool_library_settings TO farm_spool_features;
GRANT UPDATE (name, field_type, sort_order, unit, default_value, choices, multi_choice, source_key, source_sha256, updated_at) ON farm.spool_library_fields TO farm_spool_features;
GRANT UPDATE (name, sort_order, updated_at) ON farm.spool_locations TO farm_spool_features;
GRANT UPDATE (default_low_stock_threshold_grams, currency, updated_at) ON farm.spool_farm_settings TO farm_spool_features;
GRANT UPDATE (unassigned_at) ON farm.spool_slot_assignments TO farm_spool_features;
GRANT UPDATE (grams, corrected_by) ON farm.spool_usage_records TO farm_spool_features;
GRANT UPDATE (ended_at, temperature_celsius, notes) ON farm.spool_drying_logs TO farm_spool_features;
