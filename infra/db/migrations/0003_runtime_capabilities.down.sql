-- Explicit disposable-development rollback; revoke grants before dropping roles.
REVOKE UPDATE (agent_id) ON farm.connector_enrollments FROM farm_enrollment_reader;
REVOKE SELECT ON farm.connector_enrollments FROM farm_enrollment_reader;
REVOKE UPDATE (event_id) ON farm.telemetry_events FROM farm_telemetry_writer;
REVOKE SELECT, INSERT ON farm.telemetry_events FROM farm_telemetry_writer;
REVOKE USAGE ON SCHEMA farm FROM farm_enrollment_reader, farm_telemetry_writer;
DROP ROLE farm_enrollment_reader;
DROP ROLE farm_telemetry_writer;
DROP TRIGGER telemetry_no_update ON farm.telemetry_events;
DROP FUNCTION farm.telemetry_no_update();
