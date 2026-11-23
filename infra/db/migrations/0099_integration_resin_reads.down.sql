DO $$
BEGIN
  IF to_regclass('farm.resin_ledger_entries') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_integration_apps') THEN
    REVOKE SELECT (farm_id, id, printer_id, kind, target, name, volume_ml, layers, hours, source, recorded_at)
      ON farm.resin_ledger_entries FROM farm_integration_apps;
  END IF;
END $$;
