-- Spool moves between locations, printer slots and farms.
--
-- A spool keeps its per-farm (farm_id, id) row, so usage records, slot bindings,
-- drying and humidity logs are never rewritten. Moving to another farm archives
-- that row and continues the spool in the destination farm; spool_identities
-- links the rows through one identity, and moving back revives the same row.
-- Expand-only: no existing table or column is changed.
CREATE TABLE farm.spool_identities (
  farm_id uuid NOT NULL,
  spool_id bigint NOT NULL,
  identity uuid NOT NULL,
  PRIMARY KEY (farm_id, spool_id),
  UNIQUE (farm_id, identity),
  FOREIGN KEY (farm_id, spool_id) REFERENCES farm.spools (farm_id, id) ON DELETE CASCADE
);
CREATE INDEX spool_identities_identity ON farm.spool_identities (identity);

-- Append-only journal. No foreign key to farm.spools: an entry outlives its row.
CREATE TABLE farm.spool_moves (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  identity uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('location', 'slot', 'farm')),
  source_farm_id uuid NOT NULL REFERENCES farm.farms(id),
  source_spool_id bigint NOT NULL CHECK (source_spool_id >= 1),
  destination_farm_id uuid NOT NULL REFERENCES farm.farms(id),
  destination_spool_id bigint NOT NULL CHECK (destination_spool_id >= 1),
  from_value jsonb NOT NULL CHECK (jsonb_typeof(from_value) = 'object'),
  to_value jsonb NOT NULL CHECK (jsonb_typeof(to_value) = 'object'),
  moved_by text NOT NULL CHECK (char_length(moved_by) BETWEEN 1 AND 128),
  moved_at bigint NOT NULL CHECK (moved_at BETWEEN 0 AND 9007199254740991),
  CHECK ((kind = 'farm') = (source_farm_id <> destination_farm_id))
);
CREATE INDEX spool_moves_identity ON farm.spool_moves (identity, seq);

GRANT SELECT, INSERT ON farm.spool_identities, farm.spool_moves TO farm_spool_library;
