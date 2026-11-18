REVOKE SELECT ON farm.printer_latest_state FROM farm_integration_jobs;
REVOKE SELECT (farm_id, agent_id, printer_key, revoked_at) ON farm.printer_assignments FROM farm_integration_jobs;
REVOKE SELECT (sandbox) ON farm.farms FROM farm_integration_jobs;
REVOKE SELECT (cmd_id, app_id, grant_id, farm_id, agent_id, printer_assignment_id, required_scope, nonce, wire, issued_at, expires_at, status, refusal_code, result_detail, history_entry_id, created_at, updated_at) ON farm.integration_envelopes FROM farm_integration_jobs;
REVOKE SELECT, INSERT ON farm.integration_actions FROM farm_integration_jobs;
DROP TRIGGER IF EXISTS integration_action_no_truncate ON farm.integration_actions;
DROP TRIGGER IF EXISTS integration_action_guard ON farm.integration_actions;
DROP FUNCTION IF EXISTS farm.integration_action_guard();
DROP TABLE IF EXISTS farm.integration_actions;
