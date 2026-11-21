REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm FROM farm_spool_import;
REVOKE USAGE ON SCHEMA farm FROM farm_spool_import;
DROP ROLE farm_spool_import;
DROP TABLE farm.spool_library_settings;
DROP TABLE farm.spool_library_fields;
DROP TABLE farm.spool_import_identities;
DROP TABLE farm.spool_import_runs;
