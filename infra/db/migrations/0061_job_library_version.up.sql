-- Finished jobs started from the print library keep the hash and plate that were printed (expand-only).
-- Both columns are nullable: jobs imported from printer history or started outside the library stay unlinked.
ALTER TABLE farm.job_history
  ADD COLUMN library_sha256 text CHECK (library_sha256 IS NULL OR library_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN plate integer CHECK (plate IS NULL OR plate BETWEEN 1 AND 1000);
