-- Farm-scoped resin ledger: operator-recorded or Connector-reported vat changes,
-- bottles, volume adjustments and film/LCD counters, per printer.
--
-- Append-only: the runtime role may only SELECT and INSERT. A reading that was
-- never supplied stays NULL (unknown); it is never defaulted to zero.
-- Every cross-table reference is a composite (farm_id, id) foreign key.

CREATE TABLE farm.resin_ledger_entries (
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  id uuid NOT NULL,
  printer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('vat', 'bottle', 'volume', 'film', 'lcd')),
  target text CHECK (target IS NULL OR target IN ('vat', 'bottle')),
  name text CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 128 AND name = btrim(name))),
  volume_ml double precision
    CHECK (volume_ml IS NULL OR (volume_ml >= 0 AND volume_ml < 'Infinity'::float8)),
  layers bigint CHECK (layers IS NULL OR layers BETWEEN 0 AND 9007199254740991),
  hours double precision
    CHECK (hours IS NULL OR (hours >= 0 AND hours < 'Infinity'::float8)),
  source text NOT NULL CHECK (source IN ('manual', 'reported')),
  recorded_at bigint NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
  recorded_by text REFERENCES farm.session_accounts(id),
  PRIMARY KEY (farm_id, id),
  FOREIGN KEY (farm_id, printer_id) REFERENCES farm.printer_assignments (farm_id, id),
  -- Reported readings come from the Connector, not from an account.
  CHECK ((source = 'manual') = (recorded_by IS NOT NULL)),
  -- Each kind carries exactly the columns that kind defines.
  CHECK (
    (kind = 'vat' AND name IS NOT NULL AND target IS NULL AND volume_ml IS NULL AND layers IS NULL AND hours IS NULL)
    OR (kind = 'bottle' AND name IS NOT NULL AND target IS NULL AND layers IS NULL AND hours IS NULL)
    OR (kind = 'volume' AND name IS NOT NULL AND target IS NOT NULL AND volume_ml IS NOT NULL AND layers IS NULL AND hours IS NULL)
    OR (kind = 'film' AND layers IS NOT NULL AND name IS NULL AND target IS NULL AND volume_ml IS NULL AND hours IS NULL)
    OR (kind = 'lcd' AND hours IS NOT NULL AND name IS NULL AND target IS NULL AND volume_ml IS NULL AND layers IS NULL)
  )
);
CREATE INDEX resin_ledger_entries_printer
  ON farm.resin_ledger_entries (farm_id, printer_id, recorded_at DESC, id DESC);

-- Least-privilege runtime role for the resin ledger API.
CREATE ROLE farm_resin_ledger NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA farm TO farm_resin_ledger;
GRANT SELECT ON farm.session_accounts, farm.account_sessions, farm.memberships TO farm_resin_ledger;
GRANT UPDATE (id) ON farm.session_accounts TO farm_resin_ledger;
GRANT UPDATE (last_seen_at) ON farm.account_sessions TO farm_resin_ledger;
GRANT UPDATE (farm_id) ON farm.memberships TO farm_resin_ledger;
GRANT SELECT (id) ON farm.farms TO farm_resin_ledger;
GRANT SELECT (id, farm_id, printer_key, revoked_at) ON farm.printer_assignments TO farm_resin_ledger;
GRANT SELECT, INSERT ON farm.resin_ledger_entries TO farm_resin_ledger;
