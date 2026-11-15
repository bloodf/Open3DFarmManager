-- Telemetry ingestion records finished jobs with INSERT ... ON CONFLICT (farm_id, agent_id, printer_key, ended_at) DO NOTHING.
-- PostgreSQL reads the conflict columns to find the existing row, so INSERT alone is refused and the whole telemetry
-- transaction that carries a finished job fails. Read access is limited to those four columns (expand-only).
GRANT SELECT (farm_id, agent_id, printer_key, ended_at) ON farm.job_history TO farm_connector_telemetry_writer;
