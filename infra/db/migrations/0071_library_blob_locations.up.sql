-- Allow the same bytes to exist at multiple farm locations (server and/or
-- distinct Connectors) while deduplicating per (farm, sha256, location, agent).
-- Expand-only: existing rows keep their recorded location and agent_id.

ALTER TABLE farm.library_versions
  ADD COLUMN agent_id uuid,
  ADD COLUMN location_agent_id uuid GENERATED ALWAYS AS (
    COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;

CREATE OR REPLACE FUNCTION farm.library_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Library versions are retained'; END IF;
  IF (NEW.id, NEW.farm_id, NEW.item_id, NEW.version_number, NEW.sha256, NEW.size_bytes, NEW.storage_location, NEW.original_name, NEW.kind, NEW.plate_count, NEW.metadata, NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.farm_id, OLD.item_id, OLD.version_number, OLD.sha256, OLD.size_bytes, OLD.storage_location, OLD.original_name, OLD.kind, OLD.plate_count, OLD.metadata, OLD.uploaded_by, OLD.created_at)
     OR (OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN RAISE EXCEPTION 'Library version content is immutable'; END IF;
  RETURN NEW;
END;
$$;

UPDATE farm.library_versions v
SET agent_id = b.agent_id
FROM farm.library_blobs b
WHERE b.farm_id = v.farm_id
  AND b.sha256 = v.sha256
  AND v.storage_location = 'connector'
  AND v.agent_id IS NULL;

CREATE OR REPLACE FUNCTION farm.library_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Library versions are retained'; END IF;
  IF (NEW.id, NEW.farm_id, NEW.item_id, NEW.version_number, NEW.sha256, NEW.size_bytes, NEW.storage_location, NEW.agent_id, NEW.original_name, NEW.kind, NEW.plate_count, NEW.metadata, NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.farm_id, OLD.item_id, OLD.version_number, OLD.sha256, OLD.size_bytes, OLD.storage_location, OLD.agent_id, OLD.original_name, OLD.kind, OLD.plate_count, OLD.metadata, OLD.uploaded_by, OLD.created_at)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN RAISE EXCEPTION 'Library version content is immutable'; END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE farm.library_versions
  ADD CONSTRAINT library_versions_location_agent_check
    CHECK ((storage_location = 'connector') = (agent_id IS NOT NULL));

ALTER TABLE farm.library_blobs
  ADD COLUMN location_agent_id uuid GENERATED ALWAYS AS (
    COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;

DO $$
DECLARE
  fk_name text;
  pk_name text;
  uq_name text;
BEGIN
  SELECT c.conname INTO fk_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'farm' AND t.relname = 'library_versions' AND c.contype = 'f'
    AND c.confrelid = 'farm.library_blobs'::regclass;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE farm.library_versions DROP CONSTRAINT %I', fk_name);
  END IF;

  SELECT c.conname INTO pk_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'farm' AND t.relname = 'library_blobs' AND c.contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE farm.library_blobs DROP CONSTRAINT %I', pk_name);
  END IF;

  SELECT c.conname INTO uq_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'farm' AND t.relname = 'library_blobs' AND c.contype = 'u';
  IF uq_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE farm.library_blobs DROP CONSTRAINT %I', uq_name);
  END IF;
END
$$;

ALTER TABLE farm.library_blobs
  ADD CONSTRAINT library_blobs_pkey
    PRIMARY KEY (farm_id, sha256, storage_location, location_agent_id),
  ADD CONSTRAINT library_blobs_location_size_unique
    UNIQUE (farm_id, sha256, storage_location, size_bytes, location_agent_id);

ALTER TABLE farm.library_versions
  ADD CONSTRAINT library_versions_blob_location_fkey
    FOREIGN KEY (farm_id, sha256, storage_location, size_bytes, location_agent_id)
    REFERENCES farm.library_blobs (farm_id, sha256, storage_location, size_bytes, location_agent_id);

CREATE INDEX library_versions_blob_location
  ON farm.library_versions (farm_id, sha256, storage_location, location_agent_id);
