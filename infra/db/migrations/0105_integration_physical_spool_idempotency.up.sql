CREATE TABLE farm.integration_physical_spool_registrations (
  app_id uuid NOT NULL REFERENCES farm.integration_apps(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (app_id, idempotency_key)
);
GRANT SELECT, INSERT ON farm.integration_physical_spool_registrations TO farm_integration_apps;
