REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm FROM farm_spool_library;
REVOKE USAGE ON SCHEMA farm FROM farm_spool_library;
DROP ROLE farm_spool_library;
DROP TABLE farm.spool_library_credentials;
DROP TABLE farm.spools;
DROP TABLE farm.spool_filaments;
DROP TABLE farm.spool_vendors;
DROP TABLE farm.spool_library_counters;
