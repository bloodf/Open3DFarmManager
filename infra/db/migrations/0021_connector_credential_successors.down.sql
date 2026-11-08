-- Operational rollback retains this schema and its audit data. Physical down
-- is permitted only while empty, under the migration runner's transaction.
LOCK TABLE farm.connector_credential_successors IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM farm.connector_credential_successors) THEN
    RAISE EXCEPTION 'Cannot remove retained successor metadata';
  END IF;
END;
$$;
-- No CASCADE: downstream dependencies must also prevent destructive rollback.
DROP TABLE farm.connector_credential_successors;
DROP FUNCTION farm.connector_credential_successor_lifecycle();
