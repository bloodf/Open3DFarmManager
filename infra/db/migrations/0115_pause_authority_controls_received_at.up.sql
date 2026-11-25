-- Existing states have no trusted receipt time until a new observation arrives.
ALTER TABLE farm.printer_latest_state ADD COLUMN received_at bigint;

CREATE OR REPLACE VIEW farm.pause_authority_advertised_controls AS
  SELECT farm_id, agent_id, printer_key, state->'controls' AS controls, observed_at, received_at
  FROM farm.printer_latest_state;
