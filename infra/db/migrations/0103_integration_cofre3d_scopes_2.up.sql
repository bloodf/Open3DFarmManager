-- Reserve owner-grantable scopes for physical inventory, environment and alerts.
CREATE OR REPLACE FUNCTION farm.integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT scopes IS NOT NULL AND cardinality(scopes) BETWEEN 1 AND 18
    AND scopes <@ ARRAY['printers:read','files:read','inventory:read','jobs:read','jobs:start','control:basic','control:extended','events:subscribe','jobs:write','library:read','library:write','environment:read','plates:confirm','alerts:write','camera:view','inventory:write','environment:control','alerts:manage']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) AS s)
$$;
