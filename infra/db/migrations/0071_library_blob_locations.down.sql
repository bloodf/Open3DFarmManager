DROP INDEX farm.library_versions_blob_location;

ALTER TABLE farm.library_versions
  DROP CONSTRAINT library_versions_blob_location_fkey;

ALTER TABLE farm.library_blobs
  DROP CONSTRAINT library_blobs_pkey,
  DROP CONSTRAINT library_blobs_location_size_unique,
  ADD PRIMARY KEY (farm_id, sha256),
  ADD UNIQUE (farm_id, sha256, storage_location, size_bytes);

ALTER TABLE farm.library_versions
  ADD FOREIGN KEY (farm_id, sha256, storage_location, size_bytes)
    REFERENCES farm.library_blobs (farm_id, sha256, storage_location, size_bytes);

ALTER TABLE farm.library_blobs
  DROP COLUMN location_agent_id;

ALTER TABLE farm.library_versions
  DROP CONSTRAINT library_versions_location_agent_check,
  DROP COLUMN location_agent_id,
  DROP COLUMN agent_id;

CREATE OR REPLACE FUNCTION farm.library_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
