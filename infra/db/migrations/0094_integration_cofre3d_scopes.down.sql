-- Refuse to roll back while any grant still carries a scope added by 0094;
-- the owner must revoke those grants first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM farm.integration_app_grants
    WHERE scopes && ARRAY['environment:read','plates:confirm','alerts:write','camera:view']::text[]
  ) THEN
    RAISE EXCEPTION 'Integration grants still use scopes added by migration 0094';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 11
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;
