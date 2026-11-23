-- Spoolman v0.27.1 vendor and filament parity for the farm-scoped library.
--
-- Adds the upstream columns the 0085 tables lack, relaxes the checks that are
-- stricter than upstream (empty names and materials are accepted, extra-field
-- maps are bounded by the field registry rather than 64 KiB), and lets the
-- library role read the per-farm extra-field registry from 0086 so it can
-- validate, filter and sort extra values. Expand-only for existing data: no
-- row is rewritten and every existing value still satisfies the new checks.
ALTER TABLE farm.spool_vendors
  ADD COLUMN empty_spool_weight double precision
    CHECK (empty_spool_weight IS NULL OR (empty_spool_weight >= 0 AND empty_spool_weight < 'Infinity'::float8));

ALTER TABLE farm.spool_filaments
  ADD COLUMN article_number text
    CHECK (article_number IS NULL OR char_length(article_number) <= 256),
  ADD COLUMN settings_extruder_temp bigint
    CHECK (settings_extruder_temp IS NULL OR settings_extruder_temp BETWEEN 0 AND 9007199254740991),
  ADD COLUMN settings_bed_temp bigint
    CHECK (settings_bed_temp IS NULL OR settings_bed_temp BETWEEN 0 AND 9007199254740991),
  ADD COLUMN multi_color_hexes text
    CHECK (multi_color_hexes IS NULL OR (char_length(multi_color_hexes) <= 4096
      AND multi_color_hexes ~ '^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?(,[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?)+$')),
  ADD COLUMN multi_color_direction text
    CHECK (multi_color_direction IS NULL OR multi_color_direction IN ('coaxial', 'longitudinal'));

-- Upstream accepts an empty vendor name, filament name and material.
ALTER TABLE farm.spool_vendors DROP CONSTRAINT spool_vendors_name_check;
ALTER TABLE farm.spool_vendors ADD CONSTRAINT spool_vendors_name_check
  CHECK (char_length(name) <= 256);
ALTER TABLE farm.spool_filaments DROP CONSTRAINT spool_filaments_name_check;
ALTER TABLE farm.spool_filaments ADD CONSTRAINT spool_filaments_name_check
  CHECK (name IS NULL OR char_length(name) <= 256);
ALTER TABLE farm.spool_filaments DROP CONSTRAINT spool_filaments_material_check;
ALTER TABLE farm.spool_filaments ADD CONSTRAINT spool_filaments_material_check
  CHECK (material IS NULL OR char_length(material) <= 64);

-- Upstream allows up to 128 registered extra fields per entity, each value up
-- to 65535 characters. Keep a hard bound just above that.
ALTER TABLE farm.spool_vendors DROP CONSTRAINT spool_vendors_extra_check;
ALTER TABLE farm.spool_vendors ADD CONSTRAINT spool_vendors_extra_check
  CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 9437184);
ALTER TABLE farm.spool_filaments DROP CONSTRAINT spool_filaments_extra_check;
ALTER TABLE farm.spool_filaments ADD CONSTRAINT spool_filaments_extra_check
  CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 9437184);

GRANT UPDATE (empty_spool_weight) ON farm.spool_vendors TO farm_spool_library;
GRANT UPDATE (article_number, settings_extruder_temp, settings_bed_temp, multi_color_hexes, multi_color_direction)
  ON farm.spool_filaments TO farm_spool_library;
-- Read-only: the registry is written by the import and the future field API.
GRANT SELECT ON farm.spool_library_fields TO farm_spool_library;
