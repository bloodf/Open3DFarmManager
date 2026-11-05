CREATE TABLE farm.pairing_proofs (
  agent_id uuid NOT NULL REFERENCES farm.pairing_requests(agent_id),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  PRIMARY KEY (agent_id, attempt),
  nonce text UNIQUE NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 256),
  audience text NOT NULL CHECK (audience ~ '^[A-Za-z0-9:/._-]{1,128}$'),
  issued_at bigint NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254680991),
  expires_at bigint NOT NULL CHECK (expires_at > issued_at AND expires_at <= issued_at + 60000),
  next_poll_at bigint NOT NULL CHECK (next_poll_at BETWEEN issued_at AND 9007199254740991),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
  consumed_at bigint CHECK (consumed_at BETWEEN issued_at AND 9007199254740991),
  CHECK ((status = 'pending' AND consumed_at IS NULL) OR (status <> 'pending' AND consumed_at IS NOT NULL)),
  CHECK (status <> 'verified' OR consumed_at < expires_at)
);
CREATE UNIQUE INDEX pairing_one_pending_proof ON farm.pairing_proofs(agent_id) WHERE status = 'pending';
CREATE UNIQUE INDEX pairing_one_verified_proof ON farm.pairing_proofs(agent_id) WHERE status = 'verified';
CREATE FUNCTION farm.pairing_proof_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'Pairing proof tombstones must be retained'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.next_poll_at <> NEW.issued_at + 5000 THEN RAISE EXCEPTION 'Proof must start pending'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.agent_id, NEW.attempt, NEW.nonce, NEW.origin, NEW.audience, NEW.issued_at, NEW.expires_at)
    IS DISTINCT FROM (OLD.agent_id, OLD.attempt, OLD.nonce, OLD.origin, OLD.audience, OLD.issued_at, OLD.expires_at)
    OR NEW.next_poll_at < OLD.next_poll_at
    OR (OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Proof identity and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pairing_proof_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.pairing_proofs
  FOR EACH ROW EXECUTE FUNCTION farm.pairing_proof_lifecycle();
CREATE TRIGGER pairing_proof_no_truncate BEFORE TRUNCATE ON farm.pairing_proofs
  FOR EACH STATEMENT EXECUTE FUNCTION farm.pairing_proof_lifecycle();
CREATE ROLE farm_pairing_proof_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_pairing_proof_runtime;
GRANT SELECT, INSERT ON farm.pairing_proofs TO farm_pairing_proof_runtime;
GRANT UPDATE (status, consumed_at, next_poll_at) ON farm.pairing_proofs TO farm_pairing_proof_runtime;
GRANT SELECT ON farm.pairing_requests TO farm_pairing_proof_runtime;
-- Row locking requires UPDATE on a column; the existing lifecycle trigger rejects actual identity changes.
GRANT UPDATE (agent_id) ON farm.pairing_requests TO farm_pairing_proof_runtime;
