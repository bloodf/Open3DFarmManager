-- Physical Spoolman bindings, previously held only inside the idempotency
-- receipts. A binding now lives exactly as long as its spool, whatever happens
-- to the integration app that created it. Receipts stay for replay only.
CREATE TABLE farm.integration_physical_spool_bindings (
  farm_id uuid NOT NULL,
  spool_id bigint NOT NULL,
  spoolman_service_id uuid NOT NULL,
  spoolman_spool_id bigint NOT NULL
    CHECK (spoolman_spool_id BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (farm_id, spool_id),
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id) ON DELETE CASCADE,
  UNIQUE (farm_id, spoolman_service_id, spoolman_spool_id)
);
GRANT SELECT, INSERT ON farm.integration_physical_spool_bindings TO farm_integration_apps;

-- Receipts of spools that no longer exist are orphans and bind nothing.
INSERT INTO farm.integration_physical_spool_bindings
  (farm_id, spool_id, spoolman_service_id, spoolman_spool_id)
SELECT s.farm_id, s.id,
  (r.response->'spoolman'->>'serviceId')::uuid,
  (r.response->'spoolman'->>'spoolId')::bigint
FROM farm.integration_physical_spool_registrations r
JOIN farm.spools s
  ON s.farm_id = (r.response->>'farmId')::uuid
  AND s.id = (r.response->>'spoolId')::bigint
WHERE r.response ? 'spoolman';
