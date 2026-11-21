REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm FROM farm_spool_features;
REVOKE USAGE ON SCHEMA farm FROM farm_spool_features;
DROP ROLE farm_spool_features;

REVOKE SELECT ON farm.spool_library_settings, farm.spool_locations, farm.spool_farm_settings FROM farm_spool_library;
REVOKE UPDATE (low_stock_threshold_grams) ON farm.spool_filaments FROM farm_spool_library;

DROP TABLE farm.spool_humidity_readings;
DROP TABLE farm.spool_drying_logs;
DROP TABLE farm.spool_usage_records;
DROP TABLE farm.spool_slot_assignments;
DROP TABLE farm.spool_farm_settings;
DROP TABLE farm.spool_locations;

ALTER TABLE farm.spool_library_fields
  ALTER COLUMN source_key DROP DEFAULT,
  ALTER COLUMN source_sha256 DROP DEFAULT;

ALTER TABLE farm.spool_library_settings
  ALTER COLUMN source_key DROP DEFAULT,
  ALTER COLUMN source_sha256 DROP DEFAULT;

ALTER TABLE farm.spool_filaments
  DROP COLUMN low_stock_threshold_grams;

ALTER TABLE farm.job_history
  DROP CONSTRAINT job_history_farm_id_id_key;

ALTER TABLE farm.printer_assignments
  DROP CONSTRAINT printer_assignments_farm_id_id_key;
