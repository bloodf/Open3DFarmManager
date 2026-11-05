-- Complete read-only status scope. Enrollment SHARE locks serialize this read
-- with maintained ownership writers, which take enrollment UPDATE first.
-- Trusted direct SQL writers must honor that protocol; this grant cannot enforce it.
GRANT SELECT (id, farm_id, agent_id, printer_key, revoked_at)
  ON farm.printer_assignments TO farm_signalling_reader;
