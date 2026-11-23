-- The pause issuer needs advertised actions, not the full printer state.
CREATE VIEW farm.pause_authority_advertised_controls AS
  SELECT farm_id, agent_id, printer_key, state->'controls' AS controls
  FROM farm.printer_latest_state;
GRANT SELECT ON farm.pause_authority_advertised_controls TO farm_pause_authority;
