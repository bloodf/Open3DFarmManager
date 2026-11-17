REVOKE SELECT ON farm.printer_assignments, farm.printer_latest_state FROM farm_printer_latest_state_reader;
REVOKE USAGE ON SCHEMA farm FROM farm_printer_latest_state_reader;
DROP ROLE farm_printer_latest_state_reader;
DROP TABLE farm.printer_latest_state;
