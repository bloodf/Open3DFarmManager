-- Read-only access to the migration journal for startup verification and /readyz.
CREATE ROLE farm_schema_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO farm_schema_reader;
GRANT SELECT ON public.open3dfarm_migrations TO farm_schema_reader;
