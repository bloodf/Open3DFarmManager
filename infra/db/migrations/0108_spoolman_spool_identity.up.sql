-- Binding is supplied at registration and has no UPDATE grant for runtime roles.
-- Existing library and usage rows have no external provenance.
ALTER TABLE farm.spools
  ADD COLUMN spoolman_service_id uuid,
  ADD COLUMN spoolman_spool_id bigint,
  ADD CONSTRAINT spools_spoolman_binding CHECK (
    (spoolman_service_id IS NULL AND spoolman_spool_id IS NULL)
    OR (spoolman_service_id IS NOT NULL AND spoolman_spool_id IS NOT NULL
      AND spoolman_spool_id BETWEEN 1 AND 9007199254740991)
  ),
  ADD CONSTRAINT spools_spoolman_identity UNIQUE (farm_id, spoolman_service_id, spoolman_spool_id);

GRANT SELECT (spoolman_service_id, spoolman_spool_id) ON farm.spools TO farm_integration_apps;
