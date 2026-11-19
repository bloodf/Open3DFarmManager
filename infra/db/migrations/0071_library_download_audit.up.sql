-- Connector library downloads (#383). One append-only row per authenticated
-- download attempt, written before any byte is sent. The library login can only
-- insert: rows are never updated or deleted through the application.
CREATE TABLE farm.library_download_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  farm_id uuid NOT NULL REFERENCES farm.farms(id),
  agent_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('served', 'not-found', 'kept-on-connector', 'bad-range', 'rate-limited')),
  range_start bigint CHECK (range_start BETWEEN 0 AND 9007199254740991),
  range_end bigint CHECK (range_end BETWEEN 0 AND 9007199254740991),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 0 AND 9007199254740991),
  occurred_at bigint NOT NULL CHECK (occurred_at BETWEEN 0 AND 9007199254740991),
  CHECK ((range_start IS NULL) = (range_end IS NULL))
);
CREATE INDEX library_download_audit_farm ON farm.library_download_audit (farm_id, occurred_at DESC);

GRANT INSERT ON farm.library_download_audit TO farm_library;
