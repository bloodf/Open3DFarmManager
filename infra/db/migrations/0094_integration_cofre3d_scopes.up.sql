-- Owner-grantable scopes reserved for the Cofre3D integration requests:
-- environment:read, plates:confirm, alerts:write and camera:view. No endpoint
-- uses them yet; this only lets grants carry them.
CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 15
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write','environment:read','plates:confirm','alerts:write','camera:view']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;
