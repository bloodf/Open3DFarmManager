-- Existing observations have unknown age. Revisions advance under the row lock
-- for each newly accepted report, in upload order, independent of wall clocks.
ALTER TABLE farm.printer_latest_state
  ADD COLUMN age_at_send_ms bigint CHECK (age_at_send_ms >= 0),
  ADD COLUMN revision bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE VIEW farm.pause_authority_advertised_controls AS
  SELECT farm_id, agent_id, printer_key, state->'controls' AS controls, observed_at, received_at, age_at_send_ms
  FROM farm.printer_latest_state;

-- During a rolling update a legacy writer can overwrite a current row without
-- assigning a new revision. Its observation has no known send age.
CREATE FUNCTION farm.invalidate_legacy_observation_age()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.revision = OLD.revision THEN
    NEW.age_at_send_ms := NULL;
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION farm.invalidate_legacy_observation_age() FROM PUBLIC;
CREATE TRIGGER printer_legacy_observation
BEFORE UPDATE ON farm.printer_latest_state
FOR EACH ROW EXECUTE FUNCTION farm.invalidate_legacy_observation_age();
