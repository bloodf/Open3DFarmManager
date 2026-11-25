-- Expose the telemetry timestamp so the issuer can reject stale controls.
CREATE OR REPLACE VIEW farm.pause_authority_advertised_controls AS
  SELECT farm_id, agent_id, printer_key, state->'controls' AS controls, observed_at
  FROM farm.printer_latest_state;
