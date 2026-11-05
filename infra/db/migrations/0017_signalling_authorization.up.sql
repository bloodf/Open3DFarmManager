-- Passive signalling authorization uses the maintained 30-minute idle policy.
-- A policy change requires a reviewed migration and matching reader configuration.
CREATE ROLE farm_signalling_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_signalling_reader;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships,
  farm.browser_device_keys, farm.connector_enrollments, farm.connector_credentials,
  farm.connector_revocations TO farm_signalling_reader;
-- Only these rows require caller-owned locks. Existing lifecycle triggers forbid identity changes.
GRANT UPDATE (farm_id) ON farm.memberships TO farm_signalling_reader;
GRANT UPDATE (key_id) ON farm.browser_device_keys TO farm_signalling_reader;
GRANT UPDATE (agent_id) ON farm.connector_enrollments TO farm_signalling_reader;
GRANT UPDATE (jti) ON farm.connector_credentials TO farm_signalling_reader;

-- No supplied clock, policy, account identity or revocation timestamp is accepted.
-- The function can expire an actually expired session; it cannot renew or arbitrarily revoke one.
CREATE FUNCTION farm.observe_signalling_session_expiry(session_id text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, farm, pg_temp AS $$
DECLARE
  first_now pg_catalog.int8 := floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
  observed_now pg_catalog.int8;
  expected_account pg_catalog.text;
  locked_account pg_catalog.text;
  session_row farm.account_sessions%ROWTYPE;
BEGIN
  IF first_now NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid signalling authorization clock'; END IF;
  SELECT s.account_id INTO expected_account FROM farm.account_sessions s WHERE s.id = session_id;
  SELECT a.id INTO locked_account FROM farm.session_accounts a WHERE a.id = expected_account FOR SHARE;
  SELECT s.* INTO session_row FROM farm.account_sessions s WHERE s.id = session_id FOR UPDATE;
  observed_now := greatest(first_now, floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint);
  IF observed_now NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid signalling authorization clock'; END IF;
  IF locked_account IS NULL OR session_row.account_id IS DISTINCT FROM expected_account
     OR session_row.account_id IS DISTINCT FROM locked_account THEN RETURN NULL; END IF;
  IF session_row.revoked_at IS NULL AND observed_now >= session_row.last_seen_at
     AND (observed_now >= session_row.absolute_expires_at
          OR observed_now - session_row.last_seen_at >= 1800000) THEN
    UPDATE farm.account_sessions s SET revoked_at = observed_now
      WHERE s.id = session_id AND s.account_id = locked_account AND s.revoked_at IS NULL;
  END IF;
  RETURN observed_now;
END;
$$;
REVOKE ALL ON FUNCTION farm.observe_signalling_session_expiry(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm.observe_signalling_session_expiry(text) TO farm_signalling_reader;
