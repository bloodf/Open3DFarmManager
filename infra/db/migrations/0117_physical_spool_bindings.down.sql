-- The previous release reads bindings from the receipts. Refuse to drop a
-- binding that no receipt still carries, such as one whose app was deleted.
LOCK TABLE farm.integration_physical_spool_bindings IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM farm.integration_physical_spool_bindings b
    WHERE NOT EXISTS (
      SELECT 1 FROM farm.integration_physical_spool_registrations r
      WHERE r.response @> jsonb_build_object(
        'farmId', b.farm_id, 'spoolId', b.spool_id,
        'spoolman', jsonb_build_object(
          'serviceId', b.spoolman_service_id, 'spoolId', b.spoolman_spool_id))
    )
  ) THEN
    RAISE EXCEPTION 'Cannot roll back while physical spool bindings exist only in the binding table';
  END IF;
END;
$$;
DROP TABLE farm.integration_physical_spool_bindings;
