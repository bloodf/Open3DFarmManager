-- Restored check is NOT VALID so rows written under 0088 do not block rollback.
ALTER TABLE farm.spools DROP CONSTRAINT spools_extra_check;
ALTER TABLE farm.spools ADD CONSTRAINT spools_extra_check
  CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 65536) NOT VALID;
