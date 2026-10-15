-- Versioned extractions and re-extraction (issue #40, plan §6 and §8.4). Idempotent; applied files stay untouched.
--
-- A file can be read again (kernel.file.reextract). Every run is a new numbered version of the file's extraction;
-- no version is ever overwritten, so the history of what was read, and when, stays:
--   version          1, 2, 3, ... per file, assigned by a trigger as the next number when the row is inserted.
--                    UNIQUE (org_id, file_id, version): a file never has two rows with the same number.
--   status pending   a re-extraction that was requested and not finished yet. At most one per file (partial
--                    UNIQUE index), which is what dedupes repeated requests. The worker turns it into done or
--                    failed once; a final row never changes again (guard trigger, plus column-level UPDATE).
--   requested_by     the user who asked for the run (NULL for the first extraction, which the upload started).
--   completed_at     when the run finished (NULL while pending).
-- The tenant roles keep SELECT and INSERT, lose DELETE (nothing deletes an extraction; a file's deletion cascades
-- as the owner) and may update only the columns that finish a pending run.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.extraction ADD COLUMN IF NOT EXISTS version int;
ALTER TABLE crove_kernel.extraction ADD COLUMN IF NOT EXISTS requested_by uuid;
ALTER TABLE crove_kernel.extraction ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Rows from before this migration: numbered per file in creation order, finished when they were created.
UPDATE crove_kernel.extraction e
SET version = v.n
FROM (
  SELECT org_id, id, pg_catalog.row_number() OVER (PARTITION BY org_id, file_id ORDER BY created_at, id) AS n
  FROM crove_kernel.extraction
) v
WHERE e.org_id = v.org_id AND e.id = v.id AND e.version IS NULL;
UPDATE crove_kernel.extraction SET completed_at = created_at WHERE completed_at IS NULL AND status IN ('done', 'failed');

ALTER TABLE crove_kernel.extraction ALTER COLUMN version SET NOT NULL;
-- A pending run has not been read yet, so it has no method; a successful one always has.
ALTER TABLE crove_kernel.extraction ALTER COLUMN method DROP NOT NULL;
ALTER TABLE crove_kernel.extraction DROP CONSTRAINT IF EXISTS extraction_status_check;
ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_status_check CHECK (status IN ('pending', 'done', 'failed'));
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.extraction'::regclass AND conname = 'extraction_version_positive'
  ) THEN
    ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_version_positive CHECK (version > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.extraction'::regclass AND conname = 'extraction_done_has_method'
  ) THEN
    ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_done_has_method CHECK (status <> 'done' OR method IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_kernel.extraction'::regclass AND conname = 'extraction_completed'
  ) THEN
    ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_completed CHECK ((status = 'pending') = (completed_at IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS extraction_version_uq ON crove_kernel.extraction (org_id, file_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS extraction_pending_uq ON crove_kernel.extraction (org_id, file_id) WHERE status = 'pending';
-- extraction_version_uq leads with the same columns.
DROP INDEX IF EXISTS crove_kernel.extraction_file_idx;

-- Numbers a new row as the file's next version when the insert names none, and stamps a row inserted already
-- finished as completed now. Runs as the inserting role, under its RLS, so it sees only its own org's rows; the
-- UNIQUE index decides if two inserts ever race (the commands lock the file row first, so they do not).
CREATE OR REPLACE FUNCTION crove_kernel.extraction_assign_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'pending' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := pg_catalog.now();
  END IF;
  IF NEW.version IS NULL THEN
    SELECT COALESCE(pg_catalog.max(e.version), 0) + 1 INTO NEW.version
    FROM crove_kernel.extraction e
    WHERE e.org_id = NEW.org_id AND e.file_id = NEW.file_id;
  END IF;
  RETURN NEW;
END $$;

-- A finished version never changes. A pending one changes once, to done or failed, and keeps its file, number,
-- requester and creation time. org_id is left to RLS (a move to another org is refused there).
CREATE OR REPLACE FUNCTION crove_kernel.extraction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.file_id, NEW.version, NEW.requested_by, NEW.created_at, NEW.tainted)
     IS DISTINCT FROM (OLD.id, OLD.file_id, OLD.version, OLD.requested_by, OLD.created_at, OLD.tainted) THEN
    RAISE EXCEPTION 'EXTRACTION_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.method, NEW.status, NEW.result, NEW.checks, NEW.error, NEW.completed_at)
         IS DISTINCT FROM (OLD.method, OLD.status, OLD.result, OLD.checks, OLD.error, OLD.completed_at) THEN
    RAISE EXCEPTION 'EXTRACTION_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS extraction_assign_version ON crove_kernel.extraction;
CREATE TRIGGER extraction_assign_version BEFORE INSERT ON crove_kernel.extraction
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.extraction_assign_version();
DROP TRIGGER IF EXISTS extraction_guard ON crove_kernel.extraction;
CREATE TRIGGER extraction_guard BEFORE UPDATE ON crove_kernel.extraction
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.extraction_guard();

REVOKE ALL ON FUNCTION crove_kernel.extraction_assign_version(), crove_kernel.extraction_guard() FROM PUBLIC;

-- Privileges, restated: SELECT and INSERT, and UPDATE only of the columns that finish a pending run.
REVOKE ALL ON crove_kernel.extraction FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON crove_kernel.extraction FROM crove_tenant;
GRANT SELECT, INSERT ON crove_kernel.extraction TO crove_tenant;
GRANT UPDATE (method, status, result, checks, error, completed_at) ON crove_kernel.extraction TO crove_tenant;
