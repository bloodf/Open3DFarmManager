-- Refuse to roll back while any resin rows would lose their replay guard.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.library_versions WHERE kind = 'resin')
      OR EXISTS (SELECT 1 FROM farm.integration_jobs WHERE resin_profile IS NOT NULL) THEN
    RAISE EXCEPTION 'Resin artifact versions or receipts still exist';
  END IF;
END $$;

DROP TRIGGER integration_resin_replay_identity_guard ON farm.integration_jobs;
DROP FUNCTION farm.guard_integration_resin_replay_identity();
ALTER TABLE farm.integration_jobs DROP COLUMN resin_profile;
ALTER TABLE farm.library_versions DROP CONSTRAINT library_versions_kind_check;
ALTER TABLE farm.library_versions ADD CHECK (kind IN ('gcode', '3mf'));
