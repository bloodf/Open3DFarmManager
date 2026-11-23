-- Versioned print library. Storage mode is a per-farm setting (default
-- Connector). Blobs are unique per (farm, sha256): a repeated upload adds a
-- version reference, never a second stored file. Connector-mode rows hold
-- metadata, thumbnail (inside metadata) and hash only; the file stays on the
-- Connector. Expand-only: no existing table or column is changed.
CREATE TABLE farm.library_settings (
  farm_id uuid PRIMARY KEY REFERENCES farm.farms(id),
  storage_mode text NOT NULL DEFAULT 'connector' CHECK (storage_mode IN ('server', 'connector')),
  quota_bytes bigint NOT NULL DEFAULT 21474836480 CHECK (quota_bytes BETWEEN 0 AND 9007199254740991),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 128),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE farm.library_items (
  id uuid PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 32),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  archived boolean NOT NULL DEFAULT false,
  UNIQUE (farm_id, id)
);
CREATE INDEX library_items_farm ON farm.library_items (farm_id, created_at DESC);

-- One row per distinct content per farm. storage_location says where the file
-- is kept: 'server' (OPENFARM_LIBRARY_DIR/<sha256>) or 'connector'.
CREATE TABLE farm.library_blobs (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
  storage_location text NOT NULL CHECK (storage_location IN ('server', 'connector')),
  agent_id uuid,
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, sha256),
  UNIQUE (farm_id, sha256, storage_location, size_bytes),
  CHECK ((storage_location = 'connector') = (agent_id IS NOT NULL))
);

CREATE TABLE farm.library_versions (
  id uuid PRIMARY KEY,
  farm_id uuid NOT NULL,
  item_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number >= 1),
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_location text NOT NULL,
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('gcode', '3mf')),
  plate_count integer NOT NULL DEFAULT 1 CHECK (plate_count BETWEEN 0 AND 1000),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 524288),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  uploaded_by text NOT NULL CHECK (char_length(uploaded_by) BETWEEN 1 AND 128),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  deleted_at bigint CHECK (deleted_at BETWEEN 0 AND 9007199254740991),
  UNIQUE (item_id, version_number),
  FOREIGN KEY (farm_id, item_id) REFERENCES farm.library_items (farm_id, id),
  FOREIGN KEY (farm_id, sha256, storage_location, size_bytes)
    REFERENCES farm.library_blobs (farm_id, sha256, storage_location, size_bytes)
);
CREATE INDEX library_versions_blob ON farm.library_versions (farm_id, sha256);

-- Versions and blobs are immutable except notes and the soft-delete mark.
CREATE FUNCTION farm.library_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Library versions are retained'; END IF;
  IF (NEW.id, NEW.farm_id, NEW.item_id, NEW.version_number, NEW.sha256, NEW.size_bytes, NEW.storage_location, NEW.original_name, NEW.kind, NEW.plate_count, NEW.metadata, NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.farm_id, OLD.item_id, OLD.version_number, OLD.sha256, OLD.size_bytes, OLD.storage_location, OLD.original_name, OLD.kind, OLD.plate_count, OLD.metadata, OLD.uploaded_by, OLD.created_at)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN RAISE EXCEPTION 'Library version content is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER library_version_guard BEFORE UPDATE OR DELETE ON farm.library_versions
  FOR EACH ROW EXECUTE FUNCTION farm.library_version_guard();
CREATE TRIGGER library_version_guard_truncate BEFORE TRUNCATE ON farm.library_versions
  FOR EACH STATEMENT EXECUTE FUNCTION farm.library_version_guard();

CREATE FUNCTION farm.library_blob_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Library blobs are immutable';
END;
$$;
CREATE TRIGGER library_blob_guard BEFORE UPDATE OR DELETE ON farm.library_blobs
  FOR EACH ROW EXECUTE FUNCTION farm.library_blob_guard();
CREATE TRIGGER library_blob_guard_truncate BEFORE TRUNCATE ON farm.library_blobs
  FOR EACH STATEMENT EXECUTE FUNCTION farm.library_blob_guard();

CREATE ROLE farm_library NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_library;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.connector_enrollments TO farm_library;
GRANT UPDATE (id) ON farm.session_accounts TO farm_library;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_library;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_library;
GRANT UPDATE (agent_id) ON farm.connector_enrollments TO farm_library;
GRANT SELECT, INSERT ON farm.library_settings, farm.library_items, farm.library_blobs, farm.library_versions TO farm_library;
GRANT UPDATE (storage_mode, quota_bytes, retention_days, updated_by, updated_at) ON farm.library_settings TO farm_library;
GRANT UPDATE (title, tags, archived) ON farm.library_items TO farm_library;
GRANT UPDATE (notes, deleted_at) ON farm.library_versions TO farm_library;
