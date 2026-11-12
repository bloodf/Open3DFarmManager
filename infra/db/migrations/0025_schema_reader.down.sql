-- Explicit disposable-development rollback; revoke grants before dropping the role.
REVOKE SELECT ON public.open3dfarm_migrations FROM farm_schema_reader;
REVOKE USAGE ON SCHEMA public FROM farm_schema_reader;
DROP ROLE farm_schema_reader;
