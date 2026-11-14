-- Retain committed assignments and authority history. Roll back application code,
-- or restore a verified backup; never silently discard configuration receipts.
DO $$ BEGIN RAISE EXCEPTION 'Configuration history is durable; destructive rollback refused'; END $$;
