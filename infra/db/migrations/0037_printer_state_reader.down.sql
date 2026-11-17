REVOKE UPDATE (farm_id) ON farm.memberships FROM farm_printer_state_reader;
REVOKE UPDATE (last_seen_at, revoked_at) ON farm.account_sessions FROM farm_printer_state_reader;
REVOKE UPDATE (id) ON farm.session_accounts FROM farm_printer_state_reader;
REVOKE SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.printer_assignments, farm.printer_latest_state FROM farm_printer_state_reader;
REVOKE USAGE ON SCHEMA farm FROM farm_printer_state_reader;
DROP ROLE farm_printer_state_reader;
