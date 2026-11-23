GRANT SELECT (farm_id, id, printer_id, kind, target, name, volume_ml, layers, hours, source, recorded_at)
  ON farm.resin_ledger_entries TO farm_integration_apps;
