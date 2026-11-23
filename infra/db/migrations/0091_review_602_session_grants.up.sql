-- Review #602: history and printer-state readers may touch session activity only.
REVOKE UPDATE (revoked_at) ON farm.account_sessions FROM farm_printer_state_reader;
REVOKE UPDATE (revoked_at) ON farm.account_sessions FROM farm_job_history_reader;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_printer_state_reader;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_job_history_reader;
