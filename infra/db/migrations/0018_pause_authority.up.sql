-- Internal pause authority only. No commands, private signing keys or login cookies are stored.
CREATE TABLE farm.pause_authority_watermark (
  id pg_catalog.int4 PRIMARY KEY CHECK(id=1),
  observed_at pg_catalog.int8 NOT NULL CHECK(observed_at BETWEEN 0 AND 9007199251140991)
);
INSERT INTO farm.pause_authority_watermark VALUES(1,0);
CREATE TABLE farm.pause_authority_sessions (
  session_id pg_catalog.text PRIMARY KEY REFERENCES farm.account_sessions(id),
  window_started_at pg_catalog.int8 NOT NULL CHECK(window_started_at BETWEEN 0 AND 9007199251140991),
  attempts pg_catalog.int4 NOT NULL CHECK(attempts BETWEEN 1 AND 60)
);
CREATE TABLE farm.pause_authority_challenges (
  challenge_id pg_catalog.uuid PRIMARY KEY,
  session_id pg_catalog.text NOT NULL REFERENCES farm.account_sessions(id),
  account_id pg_catalog.text NOT NULL REFERENCES farm.session_accounts(id),
  farm_id pg_catalog.uuid NOT NULL REFERENCES farm.farms(id),
  agent_id pg_catalog.uuid NOT NULL REFERENCES farm.connector_enrollments(agent_id),
  key_id pg_catalog.uuid NOT NULL REFERENCES farm.browser_device_keys(key_id),
  credential_jti pg_catalog.uuid NOT NULL REFERENCES farm.connector_credentials(jti),
  assignment_id pg_catalog.uuid NOT NULL REFERENCES farm.printer_assignments(id),
  transport_id pg_catalog.uuid UNIQUE NOT NULL,
  admission_nonce pg_catalog.text NOT NULL CHECK(admission_nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  binding pg_catalog.jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(binding)='object'),
  challenge pg_catalog.jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(challenge)='object'),
  issued_at pg_catalog.int8 NOT NULL CHECK(issued_at BETWEEN 0 AND 9007199251140991),
  expires_at pg_catalog.int8 NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+8000),
  binding_expires_at pg_catalog.int8 NOT NULL CHECK(binding_expires_at>=expires_at AND binding_expires_at<=9007199251140991),
  credential_expires_at pg_catalog.int8 NOT NULL CHECK(credential_expires_at>=expires_at AND credential_expires_at<=9007199251140991),
  status pg_catalog.text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued','rejected','expired')),
  consumed_at pg_catalog.int8,
  capability_id pg_catalog.uuid UNIQUE,
  capability pg_catalog.jsonb,
  capability_hash pg_catalog.text CHECK(capability_hash ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  capability_expires_at pg_catalog.int8,
  retain_until pg_catalog.int8,
  UNIQUE(agent_id,credential_jti,admission_nonce),
  CHECK((status='pending' AND consumed_at IS NULL AND retain_until IS NULL)
    OR (status<>'pending' AND consumed_at IS NOT NULL AND retain_until IS NOT NULL AND consumed_at BETWEEN issued_at AND 9007199251140991
        AND retain_until=greatest(consumed_at,expires_at,binding_expires_at,credential_expires_at,coalesce(capability_expires_at,consumed_at))+3600000)),
  CHECK((status='issued' AND capability_id IS NOT NULL AND capability IS NOT NULL AND capability_hash IS NOT NULL
        AND capability_expires_at IS NOT NULL AND pg_catalog.jsonb_typeof(capability)='object' AND capability_expires_at>consumed_at AND capability_expires_at<=consumed_at+30000)
     OR (status<>'issued' AND capability_id IS NULL AND capability IS NULL AND capability_hash IS NULL AND capability_expires_at IS NULL))
);
CREATE INDEX pause_authority_account ON farm.pause_authority_challenges(account_id);
CREATE INDEX pause_authority_session ON farm.pause_authority_challenges(session_id);
CREATE INDEX pause_authority_retention ON farm.pause_authority_challenges(retain_until) WHERE status<>'pending';
CREATE FUNCTION farm.pause_authority_lifecycle() RETURNS pg_catalog.trigger LANGUAGE plpgsql SET search_path=pg_catalog,farm,pg_temp AS $$
DECLARE observed_now pg_catalog.int8 := floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::pg_catalog.int8;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Pause authority audit cannot be truncated'; END IF;
  IF TG_TABLE_NAME='pause_authority_watermark' THEN
    IF TG_OP<>'UPDATE' OR NEW.id<>OLD.id OR NEW.observed_at<OLD.observed_at THEN RAISE EXCEPTION 'Pause clock watermark is retained and monotonic'; END IF;
  ELSIF TG_TABLE_NAME='pause_authority_sessions' THEN
    IF TG_OP='DELETE' THEN
      IF OLD.window_started_at+3600000>observed_now OR EXISTS(SELECT 1 FROM farm.pause_authority_challenges c WHERE c.session_id=OLD.session_id) THEN RAISE EXCEPTION 'Session allocation budget still retained'; END IF;
      RETURN OLD;
    ELSIF TG_OP='UPDATE' AND (NEW.session_id<>OLD.session_id OR NEW.window_started_at<OLD.window_started_at
      OR (NEW.window_started_at=OLD.window_started_at AND NEW.attempts<>OLD.attempts+1)
      OR (NEW.window_started_at<>OLD.window_started_at AND (NEW.window_started_at<OLD.window_started_at+900000 OR NEW.attempts<>1))) THEN RAISE EXCEPTION 'Invalid pause allocation budget transition'; END IF;
  ELSE
    IF TG_OP='DELETE' THEN
      IF OLD.status='pending' OR OLD.retain_until IS NULL OR OLD.retain_until>observed_now OR OLD.expires_at>observed_now OR OLD.binding_expires_at>observed_now OR OLD.credential_expires_at>observed_now
        OR (OLD.capability_expires_at IS NOT NULL AND OLD.capability_expires_at>observed_now) THEN RAISE EXCEPTION 'Live pause nonce guard cannot be deleted'; END IF;
      RETURN OLD;
    ELSIF TG_OP='INSERT' THEN
      IF NEW.status<>'pending' THEN RAISE EXCEPTION 'Pause challenge must start pending'; END IF;
    ELSIF (NEW.challenge_id,NEW.session_id,NEW.account_id,NEW.farm_id,NEW.agent_id,NEW.key_id,NEW.credential_jti,NEW.assignment_id,NEW.transport_id,NEW.admission_nonce,NEW.binding,NEW.challenge,NEW.issued_at,NEW.expires_at,NEW.binding_expires_at,NEW.credential_expires_at)
      IS DISTINCT FROM (OLD.challenge_id,OLD.session_id,OLD.account_id,OLD.farm_id,OLD.agent_id,OLD.key_id,OLD.credential_jti,OLD.assignment_id,OLD.transport_id,OLD.admission_nonce,OLD.binding,OLD.challenge,OLD.issued_at,OLD.expires_at,OLD.binding_expires_at,OLD.credential_expires_at)
      OR (OLD.status<>'pending' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Pause identity and terminal issuance are immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pause_watermark_guard BEFORE UPDATE OR DELETE ON farm.pause_authority_watermark FOR EACH ROW EXECUTE FUNCTION farm.pause_authority_lifecycle();
CREATE TRIGGER pause_watermark_truncate BEFORE TRUNCATE ON farm.pause_authority_watermark FOR EACH STATEMENT EXECUTE FUNCTION farm.pause_authority_lifecycle();
CREATE TRIGGER pause_sessions_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.pause_authority_sessions FOR EACH ROW EXECUTE FUNCTION farm.pause_authority_lifecycle();
CREATE TRIGGER pause_sessions_truncate BEFORE TRUNCATE ON farm.pause_authority_sessions FOR EACH STATEMENT EXECUTE FUNCTION farm.pause_authority_lifecycle();
CREATE TRIGGER pause_challenges_guard BEFORE INSERT OR UPDATE OR DELETE ON farm.pause_authority_challenges FOR EACH ROW EXECUTE FUNCTION farm.pause_authority_lifecycle();
CREATE TRIGGER pause_challenges_truncate BEFORE TRUNCATE ON farm.pause_authority_challenges FOR EACH STATEMENT EXECUTE FUNCTION farm.pause_authority_lifecycle();
CREATE ROLE farm_pause_authority NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE farm_pause_authority_retention_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_pause_authority,farm_pause_authority_retention_owner;
GRANT SELECT ON farm.session_accounts,farm.account_sessions,farm.memberships,farm.browser_device_keys,
  farm.connector_enrollments,farm.connector_credentials,farm.connector_revocations,farm.connector_credential_proofs,farm.printer_assignments TO farm_pause_authority;
GRANT UPDATE(farm_id) ON farm.memberships TO farm_pause_authority;
GRANT UPDATE(key_id) ON farm.browser_device_keys TO farm_pause_authority;
GRANT UPDATE(agent_id) ON farm.connector_enrollments TO farm_pause_authority;
GRANT UPDATE(jti) ON farm.connector_credentials,farm.connector_credential_proofs TO farm_pause_authority;
GRANT UPDATE(id) ON farm.printer_assignments TO farm_pause_authority;
GRANT EXECUTE ON FUNCTION farm.observe_signalling_session_expiry(pg_catalog.text) TO farm_pause_authority;
GRANT SELECT ON farm.pause_authority_watermark,farm.pause_authority_sessions,farm.pause_authority_challenges TO farm_pause_authority,farm_pause_authority_retention_owner;
GRANT UPDATE(observed_at) ON farm.pause_authority_watermark TO farm_pause_authority,farm_pause_authority_retention_owner;
GRANT INSERT ON farm.pause_authority_sessions,farm.pause_authority_challenges TO farm_pause_authority;
GRANT UPDATE(window_started_at,attempts) ON farm.pause_authority_sessions TO farm_pause_authority;
GRANT UPDATE(status,consumed_at,capability_id,capability,capability_hash,capability_expires_at,retain_until) ON farm.pause_authority_challenges TO farm_pause_authority;
GRANT UPDATE(status,consumed_at,retain_until) ON farm.pause_authority_challenges TO farm_pause_authority_retention_owner;
GRANT DELETE ON farm.pause_authority_challenges,farm.pause_authority_sessions TO farm_pause_authority_retention_owner;
GRANT UPDATE(session_id) ON farm.pause_authority_sessions TO farm_pause_authority_retention_owner;
CREATE FUNCTION farm.prune_pause_authority() RETURNS pg_catalog.void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,farm,pg_temp AS $$
DECLARE observed_now pg_catalog.int8;
retained_watermark pg_catalog.int8;
BEGIN
  SELECT w.observed_at INTO retained_watermark FROM farm.pause_authority_watermark w WHERE w.id=1 FOR UPDATE;
  observed_now := floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::pg_catalog.int8;
  IF observed_now NOT BETWEEN 0 AND 9007199251140991 OR retained_watermark IS NULL OR observed_now<retained_watermark THEN RAISE EXCEPTION 'Pause retention clock regressed'; END IF;
  UPDATE farm.pause_authority_watermark SET observed_at=observed_now WHERE id=1;
  UPDATE farm.pause_authority_challenges c SET status='expired',consumed_at=observed_now,retain_until=greatest(observed_now,c.expires_at,c.binding_expires_at,c.credential_expires_at)+3600000
    WHERE c.challenge_id IN (SELECT p.challenge_id FROM farm.pause_authority_challenges p WHERE p.status='pending' AND p.expires_at<=observed_now ORDER BY p.expires_at,p.challenge_id LIMIT 128 FOR UPDATE);
  DELETE FROM farm.pause_authority_challenges c WHERE c.challenge_id IN
    (SELECT p.challenge_id FROM farm.pause_authority_challenges p WHERE p.status<>'pending' AND p.retain_until<=observed_now AND p.expires_at<=observed_now AND p.binding_expires_at<=observed_now AND p.credential_expires_at<=observed_now AND (p.capability_expires_at IS NULL OR p.capability_expires_at<=observed_now) ORDER BY p.retain_until,p.challenge_id LIMIT 128 FOR UPDATE);
  DELETE FROM farm.pause_authority_sessions s WHERE s.session_id IN
    (SELECT p.session_id FROM farm.pause_authority_sessions p WHERE p.window_started_at+3600000<=observed_now AND NOT EXISTS(SELECT 1 FROM farm.pause_authority_challenges c WHERE c.session_id=p.session_id) ORDER BY p.window_started_at,p.session_id LIMIT 128 FOR UPDATE);
END;
$$;
REVOKE ALL ON FUNCTION farm.prune_pause_authority() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.prune_pause_authority() TO farm_pause_authority;
GRANT CREATE ON SCHEMA farm TO farm_pause_authority_retention_owner;
ALTER FUNCTION farm.prune_pause_authority() OWNER TO farm_pause_authority_retention_owner;
REVOKE CREATE ON SCHEMA farm FROM farm_pause_authority_retention_owner;
