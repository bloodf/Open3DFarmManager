ALTER TABLE farm.printer_assignments
  ADD COLUMN display_name text
    CHECK (char_length(display_name) BETWEEN 1 AND 128 AND display_name = btrim(display_name)),
  ADD COLUMN group_name text
    CHECK (char_length(group_name) BETWEEN 1 AND 128 AND group_name = btrim(group_name)),
  ADD COLUMN location text
    CHECK (char_length(location) BETWEEN 1 AND 128 AND location = btrim(location)),
  ADD COLUMN sort_order integer
    CHECK (sort_order BETWEEN 0 AND 9999);

CREATE UNIQUE INDEX printer_assignments_display_name
  ON farm.printer_assignments (farm_id, display_name)
  WHERE display_name IS NOT NULL;

CREATE OR REPLACE FUNCTION farm.printer_assignment_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM farm.connector_enrollments
      WHERE agent_id = NEW.agent_id AND farm_id = NEW.farm_id AND status = 'approved'
    ) THEN
      RAISE EXCEPTION 'Assignment requires approved enrollment';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND
    (NEW.id, NEW.farm_id, NEW.agent_id, NEW.printer_key, NEW.created_at, NEW.created_by, NEW.revoked_by) IS NOT DISTINCT FROM
    (OLD.id, OLD.farm_id, OLD.agent_id, OLD.printer_key, OLD.created_at, OLD.created_by, OLD.revoked_by)
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
    (NEW.id, NEW.farm_id, NEW.agent_id, NEW.printer_key, NEW.created_at, NEW.created_by, NEW.display_name, NEW.group_name, NEW.location, NEW.sort_order) IS DISTINCT FROM
    (OLD.id, OLD.farm_id, OLD.agent_id, OLD.printer_key, OLD.created_at, OLD.created_by, OLD.display_name, OLD.group_name, OLD.location, OLD.sort_order)
  THEN
    RAISE EXCEPTION 'Assignment identity and tombstones are immutable';
  END IF;
  RETURN NEW;
END;
$$;

GRANT UPDATE (display_name, group_name, location, sort_order)
  ON farm.printer_assignments TO farm_printer_ownership;
