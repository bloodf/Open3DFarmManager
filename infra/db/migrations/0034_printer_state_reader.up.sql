-- Read-only role for the farm printer-state page: session and membership checks mirror printer inventory.
CREATE ROLE farm_printer_state_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_printer_state_reader;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships, farm.printer_assignments, farm.printer_latest_state TO farm_printer_state_reader;
GRANT UPDATE (id) ON farm.session_accounts TO farm_printer_state_reader;
GRANT UPDATE (last_seen_at, revoked_at) ON farm.account_sessions TO farm_printer_state_reader;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_printer_state_reader;
