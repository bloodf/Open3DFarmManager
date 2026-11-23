-- Revoke grants carrying these scopes before rolling back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM farm.integration_app_grants
    WHERE scopes && ARRAY['inventory:write','environment:control','alerts:manage']::text[]
  ) THEN
    RAISE EXCEPTION 'Integration grants still use scopes added by migration 0101';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 15
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write','environment:read','plates:confirm','alerts:write','camera:view']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;
