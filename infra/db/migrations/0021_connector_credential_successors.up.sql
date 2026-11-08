-- Storage only: no runtime principal can issue or read successors yet.
-- root_jti normalizes the immutable agent/farm/Connector-key binding from 0010.
-- JTIs are not globally unique across the root and successor tables: future
-- consumers must use exact (kind, root_jti, jti, agent_id) identities.
CREATE TABLE farm.connector_credential_successors (
  jti pg_catalog.uuid PRIMARY KEY,
  root_jti pg_catalog.uuid NOT NULL REFERENCES farm.connector_credentials(jti),
  predecessor_jti pg_catalog.uuid NOT NULL UNIQUE,
  predecessor_successor_jti pg_catalog.uuid REFERENCES farm.connector_credential_successors(jti),
  ordinal pg_catalog.int4 NOT NULL CHECK (ordinal BETWEEN 1 AND 2147483647),
  kid pg_catalog.text NOT NULL CHECK (kid ~ '^[A-Za-z0-9_-]{1,64}$'),
  issuer pg_catalog.text NOT NULL CHECK (pg_catalog.length(issuer) BETWEEN 1 AND 256),
  audience pg_catalog.text NOT NULL CHECK (pg_catalog.length(audience) BETWEEN 1 AND 256),
  issued_at pg_catalog.int8 NOT NULL CHECK (issued_at BETWEEN 0 AND 8640000000000),
  expires_at pg_catalog.int8 NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + 3600 AND expires_at <= 8640000000000),
  UNIQUE (root_jti, ordinal),
  CHECK (jti <> root_jti AND jti <> predecessor_jti),
  CHECK ((ordinal = 1 AND predecessor_jti = root_jti AND predecessor_successor_jti IS NULL)
    OR (ordinal >= 2 AND predecessor_successor_jti IS NOT NULL AND predecessor_jti = predecessor_successor_jti))
);
REVOKE ALL ON farm.connector_credential_successors FROM PUBLIC;

CREATE FUNCTION farm.connector_credential_successor_lifecycle() RETURNS pg_catalog.trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog,farm,pg_temp AS $$
DECLARE
  root farm.connector_credentials%ROWTYPE;
  enrollment farm.connector_enrollments%ROWTYPE;
  predecessor farm.connector_credential_successors%ROWTYPE;
  parent_issued pg_catalog.int8;
  parent_expires pg_catalog.int8;
  observed_now pg_catalog.numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Successor metadata must be retained unchanged';
  END IF;
  -- Discover the immutable enrollment key, then serialize before checking state.
  SELECT c.* INTO STRICT root FROM farm.connector_credentials c WHERE c.jti = NEW.root_jti;
  SELECT e.* INTO STRICT enrollment FROM farm.connector_enrollments e WHERE e.agent_id = root.agent_id FOR UPDATE;
  SELECT c.* INTO STRICT root FROM farm.connector_credentials c WHERE c.jti = NEW.root_jti FOR SHARE;
  IF enrollment.status <> 'approved' OR enrollment.farm_id <> root.farm_id
    OR enrollment.fingerprint <> root.fingerprint
    OR EXISTS (SELECT 1 FROM farm.connector_revocations r WHERE r.agent_id = root.agent_id)
  THEN RAISE EXCEPTION 'Successor requires the exact approved unrevoked enrollment'; END IF;
  IF NEW.issuer <> root.issuer OR NEW.audience <> root.audience
    OR EXISTS (SELECT 1 FROM farm.connector_credentials c WHERE c.jti = NEW.jti)
  THEN RAISE EXCEPTION 'Successor identity conflicts with root metadata'; END IF;
  IF NEW.ordinal = 1 THEN
    IF NEW.predecessor_jti <> root.jti OR NEW.predecessor_successor_jti IS NOT NULL
    THEN RAISE EXCEPTION 'First successor must name the root predecessor'; END IF;
    parent_issued := root.issued_at;
    parent_expires := root.expires_at;
  ELSE
    SELECT s.* INTO STRICT predecessor FROM farm.connector_credential_successors s
      WHERE s.jti = NEW.predecessor_successor_jti FOR SHARE;
    IF predecessor.root_jti <> root.jti OR NEW.predecessor_jti <> predecessor.jti
      OR NEW.ordinal::pg_catalog.int8 <> predecessor.ordinal::pg_catalog.int8 + 1
    THEN RAISE EXCEPTION 'Successor must extend the exact same-root predecessor'; END IF;
    parent_issued := predecessor.issued_at;
    parent_expires := predecessor.expires_at;
  END IF;
  -- Historical root expiry is not authority; only the exact live parent is used.
  -- This storage check does not replace future authenticated proof/commit checks.
  observed_now := extract(epoch FROM pg_catalog.clock_timestamp());
  IF parent_issued > observed_now OR parent_expires <= observed_now
    OR NEW.issued_at < parent_issued OR NEW.issued_at > observed_now OR NEW.expires_at <= observed_now
  THEN RAISE EXCEPTION 'Successor requires a live predecessor and current issuance'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_credential_successor_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON farm.connector_credential_successors
  FOR EACH ROW EXECUTE FUNCTION farm.connector_credential_successor_lifecycle();
CREATE TRIGGER connector_credential_successor_no_truncate
  BEFORE TRUNCATE ON farm.connector_credential_successors
  FOR EACH STATEMENT EXECUTE FUNCTION farm.connector_credential_successor_lifecycle();
