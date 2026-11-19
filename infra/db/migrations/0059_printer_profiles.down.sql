REVOKE SELECT ON farm.printer_latest_state FROM farm_printer_ownership;
REVOKE UPDATE (model, nozzle_diameter_mm, bed_size_x_mm, bed_size_y_mm, bed_size_z_mm, max_hotend_temperature_celsius, max_bed_temperature_celsius, kinematics, compatible_models, notes, updated_by, updated_at) ON farm.printer_profiles FROM farm_printer_ownership;
REVOKE SELECT, INSERT ON farm.printer_profiles FROM farm_printer_ownership;
DROP INDEX farm.printer_profiles_farm;
DROP TABLE farm.printer_profiles;
