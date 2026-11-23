REVOKE SELECT ON farm.spool_library_fields FROM farm_spool_library;
REVOKE UPDATE (article_number, settings_extruder_temp, settings_bed_temp, multi_color_hexes, multi_color_direction)
  ON farm.spool_filaments FROM farm_spool_library;
REVOKE UPDATE (empty_spool_weight) ON farm.spool_vendors FROM farm_spool_library;
-- Restored checks are NOT VALID so rows written under 0087 do not block the rollback.
ALTER TABLE farm.spool_filaments DROP CONSTRAINT spool_filaments_extra_check;
ALTER TABLE farm.spool_filaments ADD CONSTRAINT spool_filaments_extra_check
  CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 65536) NOT VALID;
ALTER TABLE farm.spool_vendors DROP CONSTRAINT spool_vendors_extra_check;
ALTER TABLE farm.spool_vendors ADD CONSTRAINT spool_vendors_extra_check
  CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 65536) NOT VALID;
ALTER TABLE farm.spool_filaments DROP CONSTRAINT spool_filaments_material_check;
ALTER TABLE farm.spool_filaments ADD CONSTRAINT spool_filaments_material_check
  CHECK (material IS NULL OR char_length(material) BETWEEN 1 AND 64) NOT VALID;
ALTER TABLE farm.spool_filaments DROP CONSTRAINT spool_filaments_name_check;
ALTER TABLE farm.spool_filaments ADD CONSTRAINT spool_filaments_name_check
  CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 256) NOT VALID;
ALTER TABLE farm.spool_vendors DROP CONSTRAINT spool_vendors_name_check;
ALTER TABLE farm.spool_vendors ADD CONSTRAINT spool_vendors_name_check
  CHECK (char_length(name) BETWEEN 1 AND 256) NOT VALID;
ALTER TABLE farm.spool_filaments
  DROP COLUMN multi_color_direction,
  DROP COLUMN multi_color_hexes,
  DROP COLUMN settings_bed_temp,
  DROP COLUMN settings_extruder_temp,
  DROP COLUMN article_number;
ALTER TABLE farm.spool_vendors DROP COLUMN empty_spool_weight;
