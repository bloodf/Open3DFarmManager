-- The scope check used by a CHECK constraint was executable by PUBLIC, so every
-- least-privilege role (pause authority, signalling, ...) could call it. Only
-- the integration role that inserts the rows needs it.
REVOKE ALL ON FUNCTION farm.integration_scopes_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.integration_scopes_valid(text[]) TO farm_integration_apps;
