DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM farm.pause_authority_challenges) OR EXISTS(SELECT 1 FROM farm.pause_authority_sessions)
     OR EXISTS(SELECT 1 FROM farm.pause_authority_watermark WHERE observed_at<>0) THEN
    RAISE EXCEPTION 'Refusing to discard retained pause authority audit';
  END IF;
END $$;
DROP FUNCTION farm.prune_pause_authority();
DROP TABLE farm.pause_authority_challenges;
DROP TABLE farm.pause_authority_sessions;
DROP TABLE farm.pause_authority_watermark;
DROP FUNCTION farm.pause_authority_lifecycle();
DROP OWNED BY farm_pause_authority,farm_pause_authority_retention_owner;
DROP ROLE farm_pause_authority;
DROP ROLE farm_pause_authority_retention_owner;
