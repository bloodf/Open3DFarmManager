DROP VIEW farm.pause_authority_advertised_controls;

CREATE VIEW farm.pause_authority_advertised_controls AS
  SELECT farm_id, agent_id, printer_key, state->'controls' AS controls, observed_at
  FROM farm.printer_latest_state;
GRANT SELECT ON farm.pause_authority_advertised_controls TO farm_pause_authority;

ALTER TABLE farm.printer_latest_state DROP COLUMN received_at;
