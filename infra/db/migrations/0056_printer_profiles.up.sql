CREATE TABLE farm.printer_profiles (
  assignment_id uuid PRIMARY KEY REFERENCES farm.printer_assignments(id),
  farm_id uuid NOT NULL,
  model text CHECK (char_length(model) BETWEEN 1 AND 64 AND model = btrim(model)),
  nozzle_diameter_mm double precision CHECK (nozzle_diameter_mm > 0 AND nozzle_diameter_mm <= 10),
  bed_size_x_mm double precision CHECK (bed_size_x_mm > 0 AND bed_size_x_mm <= 5000),
  bed_size_y_mm double precision CHECK (bed_size_y_mm > 0 AND bed_size_y_mm <= 5000),
  bed_size_z_mm double precision CHECK (bed_size_z_mm > 0 AND bed_size_z_mm <= 5000),
  max_hotend_temperature_celsius double precision CHECK (max_hotend_temperature_celsius > 0 AND max_hotend_temperature_celsius <= 1000),
  max_bed_temperature_celsius double precision CHECK (max_bed_temperature_celsius > 0 AND max_bed_temperature_celsius <= 1000),
  kinematics text CHECK (char_length(kinematics) BETWEEN 1 AND 64 AND kinematics = btrim(kinematics)),
  compatible_models text[] NOT NULL DEFAULT '{}' CHECK (cardinality(compatible_models) <= 16),
  notes text CHECK (char_length(notes) BETWEEN 1 AND 1000 AND notes = btrim(notes)),
  updated_by text NOT NULL REFERENCES farm.session_accounts(id),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX printer_profiles_farm ON farm.printer_profiles (farm_id);

GRANT SELECT, INSERT ON farm.printer_profiles TO farm_printer_ownership;
GRANT UPDATE (model, nozzle_diameter_mm, bed_size_x_mm, bed_size_y_mm, bed_size_z_mm, max_hotend_temperature_celsius, max_bed_temperature_celsius, kinematics, compatible_models, notes, updated_by, updated_at) ON farm.printer_profiles TO farm_printer_ownership;
GRANT SELECT ON farm.printer_latest_state TO farm_printer_ownership;
