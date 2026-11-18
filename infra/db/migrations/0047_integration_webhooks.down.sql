DROP TRIGGER integration_webhook_capture ON farm.integration_envelopes;
DROP TRIGGER integration_webhook_capture ON farm.integration_actions;
DROP TRIGGER integration_webhook_capture ON farm.integration_jobs;
DROP TRIGGER integration_webhook_capture ON farm.job_history;
DROP TRIGGER integration_webhook_capture ON farm.printer_latest_state;
DROP FUNCTION farm.integration_webhook_capture();
DROP FUNCTION farm.integration_webhook_allowed(uuid, uuid, uuid);
DROP TABLE farm.integration_webhook_outbox;
DROP TABLE farm.integration_webhooks;
