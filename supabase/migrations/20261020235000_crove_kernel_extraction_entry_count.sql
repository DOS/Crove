-- Bulk intake follow-up (issue #432): an opened archive's entry count in a column of its own. files.batch and
-- files.recent showed it with jsonb_array_length(result -> 'entries'), which makes PostgreSQL decompress the archive's
-- whole result (up to 500 entries) for every listed file. Idempotent; applied files stay untouched.
--
-- crove_kernel.extraction.entry_count   how many entries the run's result lists, for a run with method 'archive';
--                                       NULL for every other run. Set by the database on insert and update (trigger
--                                       extraction_entry_count) from the result itself, so it cannot disagree with
--                                       it and no role writes it: crove_tenant holds no UPDATE on the column, and an
--                                       INSERT that names it is overwritten.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.extraction ADD COLUMN IF NOT EXISTS entry_count int;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.extraction'::regclass AND conname = 'extraction_entry_count_archive'
  ) THEN
    ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_entry_count_archive
      CHECK (entry_count IS NULL OR (method = 'archive' AND entry_count >= 0));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.extraction_entry_count() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Nested so that only an archive's result is ever read (CASE evaluates in order).
  NEW.entry_count := CASE WHEN NEW.method = 'archive' THEN
    CASE WHEN pg_catalog.jsonb_typeof(NEW.result -> 'entries') = 'array' THEN pg_catalog.jsonb_array_length(NEW.result -> 'entries') END
  END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.extraction_entry_count() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

DROP TRIGGER IF EXISTS extraction_entry_count ON crove_kernel.extraction;
CREATE TRIGGER extraction_entry_count BEFORE INSERT OR UPDATE ON crove_kernel.extraction
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.extraction_entry_count();

-- Backfill: archives opened before this migration. Their runs are finished, and the guard trigger lets an update
-- through that changes none of the columns it protects; the new trigger sets the same count. Rows that already have
-- it are skipped, so a second run changes nothing.
UPDATE crove_kernel.extraction
SET entry_count = pg_catalog.jsonb_array_length(result -> 'entries')
WHERE method = 'archive' AND entry_count IS NULL AND pg_catalog.jsonb_typeof(result -> 'entries') = 'array';
