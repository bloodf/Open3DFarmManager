LOCK TABLE farm.integration_physical_spool_registrations IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.integration_physical_spool_registrations) THEN
    RAISE EXCEPTION 'Cannot roll back while physical spool registration keys are retained';
  END IF;
END;
$$;
DROP TABLE farm.integration_physical_spool_registrations;
