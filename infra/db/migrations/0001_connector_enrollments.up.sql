-- Draft isolated enrollment schema. Apply explicitly to this product's dedicated DB.
CREATE SCHEMA farm;
CREATE TABLE farm.connector_enrollments (
  agent_id uuid PRIMARY KEY,
  farm_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revoked')),
  public_key_spki text NOT NULL CHECK (length(public_key_spki) = 59),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 50)
);
CREATE FUNCTION farm.enrollment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'Enrollment must start pending'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'Enrollment tombstones must be retained'; END IF;
  IF (NEW.agent_id, NEW.farm_id, NEW.public_key_spki, NEW.fingerprint)
    IS DISTINCT FROM (OLD.agent_id, OLD.farm_id, OLD.public_key_spki, OLD.fingerprint)
  THEN RAISE EXCEPTION 'Enrollment identity is immutable'; END IF;
  IF (OLD.status = 'revoked' AND NEW.status <> 'revoked')
    OR (OLD.status = 'approved' AND NEW.status = 'pending')
  THEN RAISE EXCEPTION 'Enrollment transition is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enrollment_lifecycle BEFORE INSERT OR UPDATE OR DELETE
  ON farm.connector_enrollments FOR EACH ROW EXECUTE FUNCTION farm.enrollment_lifecycle();
CREATE TRIGGER enrollment_no_truncate BEFORE TRUNCATE
  ON farm.connector_enrollments FOR EACH STATEMENT EXECUTE FUNCTION farm.enrollment_lifecycle();
