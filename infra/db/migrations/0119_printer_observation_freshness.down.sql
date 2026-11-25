DROP TRIGGER printer_legacy_observation ON farm.printer_latest_state;
DROP FUNCTION farm.invalidate_legacy_observation_age();
DROP VIEW farm.pause_authority_advertised_controls;
CREATE OR REPLACE VIEW farm.pause_authority_advertised_controls AS
  SELECT farm_id, agent_id, printer_key, state->'controls' AS controls, observed_at, received_at
  FROM farm.printer_latest_state;
GRANT SELECT ON farm.pause_authority_advertised_controls TO farm_pause_authority;

ALTER TABLE farm.printer_latest_state DROP COLUMN age_at_send_ms, DROP COLUMN revision;
