ALTER TABLE farm.job_history
  ADD COLUMN filament_usage jsonb
  CHECK (filament_usage IS NULL OR jsonb_typeof(filament_usage) = 'array');
