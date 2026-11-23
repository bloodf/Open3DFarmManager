ALTER TABLE farm.library_versions DROP CONSTRAINT library_versions_kind_check;
ALTER TABLE farm.library_versions ADD CONSTRAINT library_versions_kind_check CHECK (
  kind IN ('gcode', '3mf')
  OR (kind = 'resin' AND plate_count = 1
    AND COALESCE(jsonb_typeof(metadata->'resinProfile') = 'string', false))
);

ALTER TABLE farm.integration_jobs ADD COLUMN resin_profile text
  CHECK (resin_profile IS NULL OR (library_version_id IS NOT NULL AND plate IS NOT DISTINCT FROM 1));

CREATE FUNCTION farm.guard_integration_resin_replay_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Resin replay identity is immutable';
END $$;

CREATE TRIGGER integration_resin_replay_identity_guard
  BEFORE UPDATE OF library_version_id, plate, resin_profile, storage_mode ON farm.integration_jobs
  FOR EACH ROW WHEN (
    (OLD.resin_profile IS NOT NULL OR NEW.resin_profile IS NOT NULL)
    AND (OLD.library_version_id, OLD.plate, OLD.resin_profile, OLD.storage_mode)
      IS DISTINCT FROM (NEW.library_version_id, NEW.plate, NEW.resin_profile, NEW.storage_mode)
  ) EXECUTE FUNCTION farm.guard_integration_resin_replay_identity();
