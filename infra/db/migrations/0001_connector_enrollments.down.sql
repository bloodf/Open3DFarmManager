-- Destructive rollback for disposable development DBs only. Never run automatically.
DROP TABLE farm.connector_enrollments;
DROP FUNCTION farm.enrollment_lifecycle();
DROP SCHEMA farm;
