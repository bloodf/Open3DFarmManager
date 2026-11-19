REVOKE UPDATE (display_name, group_name, location, sort_order) ON farm.printer_assignments FROM farm_printer_ownership;

CREATE OR REPLACE FUNCTION farm.printer_assignment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM farm.connector_enrollments WHERE agent_id = NEW.agent_id AND farm_id = NEW.farm_id AND status = 'approved') THEN
      RAISE EXCEPTION 'Assignment requires approved enrollment';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
    (NEW.id, NEW.farm_id, NEW.agent_id, NEW.printer_key, NEW.created_at, NEW.created_by) IS DISTINCT FROM
    (OLD.id, OLD.farm_id, OLD.agent_id, OLD.printer_key, OLD.created_at, OLD.created_by)
  THEN RAISE EXCEPTION 'Assignment identity and tombstones are immutable'; END IF;
  RETURN NEW;
END;
$$;

DROP INDEX farm.printer_assignments_display_name;

ALTER TABLE farm.printer_assignments
  DROP COLUMN sort_order,
  DROP COLUMN location,
  DROP COLUMN group_name,
  DROP COLUMN display_name;
