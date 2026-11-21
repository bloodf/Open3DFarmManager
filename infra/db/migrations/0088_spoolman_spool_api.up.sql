-- Spoolman v0.27.1 spool API parity for the farm-scoped library.
--
-- Relaxes the spool extra-field JSONB size check to match 0087's vendor and
-- filament bound (up to 128 registered extra fields of 65535 characters each).
-- Expand-only: every existing row already satisfies the new check.
ALTER TABLE farm.spools DROP CONSTRAINT spools_extra_check;
ALTER TABLE farm.spools ADD CONSTRAINT spools_extra_check
  CHECK (jsonb_typeof(extra) = 'object' AND pg_column_size(extra) <= 9437184);
