-- Library quota and retention (#378). Expand-only: nothing existing is dropped.
-- A purged blob keeps its row (versions still reference it) and is marked with
-- purged_at, so replays can say the file was removed. Retention runs as its own
-- login role, like the telemetry prune (0036): it can only mark blobs purged and
-- soft-delete versions; it can never delete rows.
ALTER TABLE farm.library_blobs ADD COLUMN purged_at bigint CHECK (purged_at BETWEEN 0 AND 9007199254740991);
ALTER TABLE farm.library_settings ADD COLUMN keep_versions integer CHECK (keep_versions BETWEEN 1 AND 1000);

-- Space a Connector host reports for its own library directory (Connector mode).
CREATE TABLE farm.library_connector_storage (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  agent_id uuid NOT NULL,
  quota_bytes bigint NOT NULL CHECK (quota_bytes BETWEEN 0 AND 9007199254740991),
  used_bytes bigint NOT NULL CHECK (used_bytes BETWEEN 0 AND 9007199254740991),
  reported_at bigint NOT NULL CHECK (reported_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (farm_id, agent_id)
);

-- Blobs stay immutable except for the purge mark (set on purge, cleared when the same bytes are uploaded again).
CREATE OR REPLACE FUNCTION farm.library_blob_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.farm_id, NEW.sha256, NEW.size_bytes, NEW.storage_location, NEW.agent_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.farm_id, OLD.sha256, OLD.size_bytes, OLD.storage_location, OLD.agent_id, OLD.created_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Library blobs are immutable';
END;
$$;

GRANT UPDATE (purged_at) ON farm.library_blobs TO farm_library;
GRANT UPDATE (keep_versions) ON farm.library_settings TO farm_library;
GRANT SELECT, INSERT, UPDATE ON farm.library_connector_storage TO farm_library;

CREATE ROLE farm_library_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_library_retention;
GRANT SELECT ON farm.library_settings, farm.library_blobs, farm.library_versions, farm.library_connector_storage TO farm_library_retention;
GRANT UPDATE (purged_at) ON farm.library_blobs TO farm_library_retention;
GRANT UPDATE (deleted_at) ON farm.library_versions TO farm_library_retention;
