-- Removing this read capability makes assignment-bound signalling fail closed.
-- Assignment identities/tombstones remain intact; no binding is downgraded to v1.
REVOKE SELECT (id, farm_id, agent_id, printer_key, revoked_at)
  ON farm.printer_assignments FROM farm_signalling_reader;
