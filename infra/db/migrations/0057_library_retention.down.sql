REVOKE UPDATE (deleted_at) ON farm.library_versions FROM farm_library_retention;
REVOKE UPDATE (purged_at) ON farm.library_blobs FROM farm_library_retention;
REVOKE ALL PRIVILEGES ON farm.library_settings, farm.library_blobs, farm.library_versions, farm.library_connector_storage FROM farm_library_retention;
REVOKE USAGE ON SCHEMA farm FROM farm_library_retention;
DROP ROLE farm_library_retention;
REVOKE ALL PRIVILEGES ON farm.library_connector_storage FROM farm_library;
REVOKE UPDATE (keep_versions) ON farm.library_settings FROM farm_library;
REVOKE UPDATE (purged_at) ON farm.library_blobs FROM farm_library;
CREATE OR REPLACE FUNCTION farm.library_blob_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Library blobs are immutable';
END;
$$;
DROP TABLE farm.library_connector_storage;
ALTER TABLE farm.library_settings DROP COLUMN keep_versions;
ALTER TABLE farm.library_blobs DROP COLUMN purged_at;
