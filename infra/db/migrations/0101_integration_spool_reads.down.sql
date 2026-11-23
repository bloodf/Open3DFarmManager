REVOKE SELECT (farm_id, id, filament_id, location, initial_weight, used_weight, archived)
  ON farm.spools FROM farm_integration_apps;
REVOKE SELECT (farm_id, id, name, material, color_hex, weight)
  ON farm.spool_filaments FROM farm_integration_apps;
REVOKE SELECT (farm_id, spool_id, printer_id, slot_kind, slot_index, assigned_at, unassigned_at)
  ON farm.spool_slot_assignments FROM farm_integration_apps;
REVOKE SELECT (id, farm_id, job_id, spool_id, printer_id, grams, source, created_at, corrected_by)
  ON farm.spool_usage_records FROM farm_integration_apps;
