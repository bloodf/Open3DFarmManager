CREATE ROLE farm_connector_credential_renewer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_connector_credential_renewer;
CREATE TABLE farm.connector_credential_renewals (
 root_jti uuid NOT NULL REFERENCES farm.connector_credentials(jti),
 predecessor_kind text NOT NULL CHECK (predecessor_kind IN ('root','successor')),
 predecessor_jti uuid NOT NULL,
 predecessor_successor_jti uuid REFERENCES farm.connector_credential_successors(jti),
 state text NOT NULL DEFAULT 'OBSERVED' CHECK (state IN ('OBSERVED','RESERVED','COMMITTED')),
 parent_observed_at bigint NOT NULL CHECK (parent_observed_at >= 0),
 parent_expired_at bigint CHECK (parent_expired_at >= 0),
 child_observed_at bigint CHECK (child_observed_at >= 0),
 child_expired_at bigint CHECK (child_expired_at >= 0),
 reservation jsonb,
 challenge jsonb,
 consumed boolean NOT NULL DEFAULT false,
 attempt bigint NOT NULL DEFAULT 0 CHECK (attempt >= 0),
 committed_child_jti uuid REFERENCES farm.connector_credential_successors(jti),
 result_token_sha256 text CHECK (result_token_sha256 ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
 authorized_at bigint CHECK (authorized_at >= 0),
 PRIMARY KEY(root_jti,predecessor_kind,predecessor_jti),
 CHECK ((predecessor_kind='root' AND predecessor_jti=root_jti AND predecessor_successor_jti IS NULL) OR (predecessor_kind='successor' AND predecessor_jti<>root_jti AND predecessor_successor_jti=predecessor_jti)),
 CHECK ((state='OBSERVED' AND reservation IS NULL AND challenge IS NULL AND attempt=0 AND NOT consumed AND committed_child_jti IS NULL AND result_token_sha256 IS NULL AND authorized_at IS NULL AND child_observed_at IS NULL AND child_expired_at IS NULL)
 OR (state='RESERVED' AND reservation IS NOT NULL AND challenge IS NOT NULL AND attempt>0 AND committed_child_jti IS NULL AND result_token_sha256 IS NULL AND authorized_at IS NULL AND child_observed_at IS NULL AND child_expired_at IS NULL)
 OR (state='COMMITTED' AND reservation IS NOT NULL AND challenge IS NOT NULL AND attempt>0 AND committed_child_jti IS NOT NULL AND result_token_sha256 IS NOT NULL AND authorized_at IS NOT NULL AND child_observed_at IS NOT NULL)),
 CHECK (parent_expired_at IS NULL OR parent_expired_at<=parent_observed_at),
 CHECK (child_expired_at IS NULL OR child_expired_at<=child_observed_at)
);
CREATE UNIQUE INDEX connector_renewal_reserved_child ON farm.connector_credential_renewals ((reservation->>'childJti')) WHERE reservation IS NOT NULL;
REVOKE ALL ON farm.connector_credential_renewals FROM PUBLIC;
CREATE FUNCTION farm.connector_renewal_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,farm,pg_temp AS $$
DECLARE root farm.connector_credentials%ROWTYPE; parent farm.connector_credential_successors%ROWTYPE; child farm.connector_credential_successors%ROWTYPE; parent_exp bigint; parent_ord integer; r jsonb;
BEGIN
 IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'Renewal observations and receipts must be retained'; END IF;
 SELECT c.* INTO STRICT root FROM farm.connector_credentials c WHERE c.jti=NEW.root_jti;
 parent_exp:=root.expires_at; parent_ord:=0;
 IF NEW.predecessor_kind='successor' THEN
  SELECT s.* INTO STRICT parent FROM farm.connector_credential_successors s WHERE s.jti=NEW.predecessor_jti AND s.root_jti=NEW.root_jti;
  parent_exp:=parent.expires_at; parent_ord:=parent.ordinal;
 END IF;
 IF TG_OP='INSERT' AND NEW.state<>'OBSERVED' THEN RAISE EXCEPTION 'Start with authenticated observation'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.state='OBSERVED' AND NEW.state NOT IN ('OBSERVED','RESERVED') THEN RAISE EXCEPTION 'Observation must reserve before committing'; END IF;
  IF OLD.state='RESERVED' AND NEW.state='COMMITTED' AND (OLD.parent_expired_at IS NOT NULL OR NEW.parent_observed_at>=parent_exp*1000 OR extract(epoch FROM clock_timestamp())>=parent_exp) THEN RAISE EXCEPTION 'Commit requires live parent'; END IF;
  IF ROW(NEW.root_jti,NEW.predecessor_kind,NEW.predecessor_jti,NEW.predecessor_successor_jti) IS DISTINCT FROM ROW(OLD.root_jti,OLD.predecessor_kind,OLD.predecessor_jti,OLD.predecessor_successor_jti)
   OR NEW.parent_observed_at<OLD.parent_observed_at OR (OLD.parent_expired_at IS NOT NULL AND NEW.parent_expired_at IS DISTINCT FROM OLD.parent_expired_at)
   OR (OLD.child_observed_at IS NOT NULL AND (NEW.child_observed_at IS NULL OR NEW.child_observed_at<OLD.child_observed_at))
   OR (OLD.child_expired_at IS NOT NULL AND NEW.child_expired_at IS DISTINCT FROM OLD.child_expired_at)
   OR (OLD.reservation IS NOT NULL AND NEW.reservation IS DISTINCT FROM OLD.reservation)
   OR (OLD.state='COMMITTED' AND ROW(NEW.state,NEW.committed_child_jti,NEW.result_token_sha256,NEW.authorized_at) IS DISTINCT FROM ROW(OLD.state,OLD.committed_child_jti,OLD.result_token_sha256,OLD.authorized_at))
   OR (OLD.state='RESERVED' AND NEW.state='OBSERVED')
  THEN RAISE EXCEPTION 'Renewal identity, receipt and observations are monotone'; END IF;
  IF NEW.challenge IS DISTINCT FROM OLD.challenge THEN
   IF NEW.attempt<>OLD.attempt+1 OR (OLD.challenge IS NOT NULL AND NEW.challenge->>'nonce'=OLD.challenge->>'nonce') OR NEW.consumed OR (OLD.challenge IS NOT NULL AND NOT OLD.consumed AND (OLD.challenge->>'expiresAt')::bigint>greatest(NEW.parent_observed_at,coalesce(NEW.child_observed_at,0))) THEN RAISE EXCEPTION 'Cannot replace pending challenge'; END IF;
  ELSIF NEW.attempt<>OLD.attempt OR (OLD.consumed AND NOT NEW.consumed) THEN RAISE EXCEPTION 'Cannot revive challenge'; END IF;
 END IF;
 r:=NEW.reservation;
 IF r IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM jsonb_each(r) WHERE value='null'::jsonb) OR jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>9
   OR NOT (r ?& ARRAY['childJti','ordinal','kid','issuer','audience','issuedAt','expiresAt','tokenHash','codec'])
  THEN RAISE EXCEPTION 'Invalid reservation shape'; END IF;
  IF jsonb_typeof(r->'childJti')<>'string' OR jsonb_typeof(r->'kid')<>'string' OR jsonb_typeof(r->'issuer')<>'string' OR jsonb_typeof(r->'audience')<>'string' OR jsonb_typeof(r->'tokenHash')<>'string' OR jsonb_typeof(r->'ordinal')<>'number' OR jsonb_typeof(r->'issuedAt')<>'number' OR jsonb_typeof(r->'expiresAt')<>'number' OR r->>'ordinal' !~ '^[0-9]+$' OR r->>'issuedAt' !~ '^[0-9]+$' OR r->>'expiresAt' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Invalid reservation types'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.state='OBSERVED' AND NEW.state='RESERVED' THEN
  IF NEW.parent_expired_at IS NOT NULL OR NEW.parent_observed_at>=parent_exp*1000 OR extract(epoch FROM clock_timestamp())>=parent_exp
   OR NOT EXISTS(SELECT 1 FROM farm.connector_enrollments e WHERE e.agent_id=root.agent_id AND e.status='approved' AND e.farm_id=root.farm_id AND e.fingerprint=root.fingerprint)
   OR EXISTS(SELECT 1 FROM farm.connector_revocations v WHERE v.agent_id=root.agent_id)
  THEN RAISE EXCEPTION 'Reservation requires a live unrevoked predecessor'; END IF;
 END IF;
 IF r IS NOT NULL THEN
  IF (r->>'ordinal')::bigint<>parent_ord::bigint+1 OR (r->>'codec')::integer<>1 OR (r->>'childJti')::uuid IN (NEW.root_jti,NEW.predecessor_jti)
   OR r->>'issuer'<>root.issuer OR r->>'audience'<>root.audience OR NOT (r->>'kid' ~ '^[A-Za-z0-9_-]{1,64}$')
   OR NOT (r->>'tokenHash' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$')
   OR (r->>'issuedAt')::bigint<0 OR (r->>'expiresAt')::bigint<=(r->>'issuedAt')::bigint OR (r->>'expiresAt')::bigint>(r->>'issuedAt')::bigint+3600
  THEN RAISE EXCEPTION 'Invalid immutable reservation'; END IF;
 END IF;
 IF NEW.challenge IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM jsonb_each(NEW.challenge) WHERE value='null'::jsonb) OR EXISTS(SELECT 1 FROM jsonb_each(NEW.challenge->'identity') WHERE value='null'::jsonb) OR jsonb_typeof(NEW.challenge)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.challenge))<>14 OR NOT (NEW.challenge ?& ARRAY['v','mode','identity','farmId','origin','audience','publicKeySpki','fingerprint','thumbprint','reservation','nonce','attempt','issuedAt','expiresAt']) OR jsonb_typeof(NEW.challenge->'identity')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(NEW.challenge->'identity'))<>4 OR NOT ((NEW.challenge->'identity') ?& ARRAY['kind','rootJti','jti','agentId']) OR (NEW.challenge->>'v')::integer<>1 OR NEW.challenge->>'mode' NOT IN ('issue','readback') OR NEW.challenge->'reservation' IS DISTINCT FROM r OR NEW.challenge->'identity'->>'kind'<>NEW.predecessor_kind OR (NEW.challenge->'identity'->>'rootJti')::uuid<>NEW.root_jti OR (NEW.challenge->'identity'->>'jti')::uuid<>NEW.predecessor_jti OR (NEW.challenge->'identity'->>'agentId')::uuid<>root.agent_id OR (NEW.challenge->>'farmId')::uuid<>root.farm_id OR NEW.challenge->>'fingerprint'<>root.fingerprint OR NEW.challenge->>'thumbprint'<>root.thumbprint OR (NEW.challenge->>'attempt')::bigint<>NEW.attempt OR (NEW.challenge->>'expiresAt')::bigint<=(NEW.challenge->>'issuedAt')::bigint OR (NEW.challenge->>'expiresAt')::bigint>(NEW.challenge->>'issuedAt')::bigint+60000 THEN RAISE EXCEPTION 'Invalid exact challenge binding'; END IF;
  IF NEW.state='RESERVED' AND NEW.challenge->>'mode'<>'issue' THEN RAISE EXCEPTION 'Readback needs committed receipt'; END IF;
 END IF;
 IF NEW.state='COMMITTED' THEN
  SELECT s.* INTO STRICT child FROM farm.connector_credential_successors s WHERE s.jti=NEW.committed_child_jti AND s.root_jti=NEW.root_jti AND s.predecessor_jti=NEW.predecessor_jti;
  IF child.jti<>(r->>'childJti')::uuid OR child.ordinal<>(r->>'ordinal')::integer OR child.kid<>r->>'kid' OR child.issuer<>r->>'issuer' OR child.audience<>r->>'audience' OR child.issued_at<>(r->>'issuedAt')::bigint OR child.expires_at<>(r->>'expiresAt')::bigint OR NEW.authorized_at>=parent_exp*1000 THEN RAISE EXCEPTION 'Receipt must name exact authorized child'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER connector_renewal_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON farm.connector_credential_renewals FOR EACH ROW EXECUTE FUNCTION farm.connector_renewal_lifecycle();
CREATE TRIGGER connector_renewal_no_truncate BEFORE TRUNCATE ON farm.connector_credential_renewals FOR EACH STATEMENT EXECUTE FUNCTION farm.connector_renewal_lifecycle();
GRANT SELECT ON farm.connector_enrollments,farm.connector_credentials,farm.connector_credential_successors,farm.connector_revocations TO farm_connector_credential_renewer;
GRANT UPDATE(agent_id) ON farm.connector_enrollments TO farm_connector_credential_renewer;
GRANT UPDATE(jti) ON farm.connector_credentials,farm.connector_credential_successors TO farm_connector_credential_renewer;
GRANT INSERT ON farm.connector_credential_successors TO farm_connector_credential_renewer;
GRANT SELECT,INSERT ON farm.connector_credential_renewals TO farm_connector_credential_renewer;
GRANT UPDATE(state,parent_observed_at,parent_expired_at,child_observed_at,child_expired_at,reservation,challenge,consumed,attempt,committed_child_jti,result_token_sha256,authorized_at) ON farm.connector_credential_renewals TO farm_connector_credential_renewer;
