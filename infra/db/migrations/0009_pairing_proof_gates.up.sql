ALTER TABLE farm.pairing_requests ADD COLUMN proof_expired_at bigint
  CHECK (proof_expired_at BETWEEN issued_at AND 9007199254740991);
CREATE FUNCTION farm.pairing_proof_expiry_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.proof_expired_at IS NOT NULL THEN RAISE EXCEPTION 'Pairing expiry marker must start empty'; END IF;
  ELSIF OLD.proof_expired_at IS NOT NULL AND NEW.proof_expired_at IS DISTINCT FROM OLD.proof_expired_at THEN
    RAISE EXCEPTION 'Observed proof expiry is terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pairing_proof_expiry_lifecycle BEFORE INSERT OR UPDATE ON farm.pairing_requests
  FOR EACH ROW EXECUTE FUNCTION farm.pairing_proof_expiry_lifecycle();
GRANT SELECT ON farm.pairing_proofs TO farm_pairing_runtime;
-- FOR SHARE requires UPDATE on a column. Proof identity and terminal-state guards reject changes.
GRANT UPDATE (agent_id) ON farm.pairing_proofs TO farm_pairing_runtime;
GRANT UPDATE (proof_expired_at) ON farm.pairing_requests TO farm_pairing_runtime;
