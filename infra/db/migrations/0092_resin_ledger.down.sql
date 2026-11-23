REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA farm FROM farm_resin_ledger;
REVOKE USAGE ON SCHEMA farm FROM farm_resin_ledger;
DROP ROLE farm_resin_ledger;

DROP TABLE farm.resin_ledger_entries;
