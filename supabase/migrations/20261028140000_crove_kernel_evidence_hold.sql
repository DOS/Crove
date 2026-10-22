-- Retention holds on evidence files (issue #1009, ADR-0013, plan External-tenant gate T7). Idempotent; applied files
-- stay untouched.
--
-- A file that backs a posted journal entry (the original file of a recorded invoice) is held in the bucket for
-- EVIDENCE_LOCK_DAYS (default 3650) from the posting, as an S3 Object Lock retention in GOVERNANCE mode on the version
-- the file row records. The posting itself writes nothing new: which files need a hold, and from when, follows from
-- the books. The worker sets the hold after the posting committed (S3 calls never run inside a transaction) and
-- records the outcome on the file row.
--
-- crove_kernel.file                   held_until: the retention the store confirmed on the recorded version (null: no
--                                     hold set yet); hold_attempted_at, hold_attempts and hold_error: the last attempt,
--                                     how many failed in a row (for the backoff) and why the last one failed.
-- crove_kernel.file_guard             as before, a file reference never changes; the four hold columns change only in a
--                                     system context (the worker's kernel.file.hold.record), and held_until never goes
--                                     back to null or to an earlier time.
-- crove_kernel.evidence_hold_due      the worker's scan, across orgs that are not closed, of files whose hold is missing
--                                     or shorter than p_days from their latest posting, with a backoff after failures.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS held_until timestamptz;
ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS hold_attempted_at timestamptz;
ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS hold_attempts int NOT NULL DEFAULT 0;
ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS hold_error text;
-- NOT VALID: no scan of the file table under its lock. Existing rows hold the defaults (0 and null), which satisfy
-- both checks, and every insert and update is checked.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'file_hold_attempts_check' AND conrelid = 'crove_kernel.file'::regclass) THEN
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_hold_attempts_check CHECK (hold_attempts >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'file_hold_error_check' AND conrelid = 'crove_kernel.file'::regclass) THEN
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_hold_error_check CHECK (pg_catalog.char_length(hold_error) <= 500) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.sha256, NEW.storage_key, NEW.generation, NEW.filename, NEW.content_type, NEW.size_bytes, NEW.source,
      NEW.created_by, NEW.created_at, NEW.duration_ms)
     IS DISTINCT FROM (OLD.id, OLD.sha256, OLD.storage_key, OLD.generation, OLD.filename, OLD.content_type, OLD.size_bytes,
      OLD.source, OLD.created_by, OLD.created_at, OLD.duration_ms) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a file reference (key, generation, sha256) never changes';
  END IF;
  IF (NEW.image_width, NEW.image_height) IS DISTINCT FROM (OLD.image_width, OLD.image_height)
     AND NOT (OLD.image_width IS NULL AND OLD.image_height IS NULL
              AND NEW.image_width IS NOT NULL AND NEW.image_height IS NOT NULL
              AND crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system') THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'an image size is recorded once, by the system';
  END IF;
  IF (NEW.held_until, NEW.hold_attempted_at, NEW.hold_attempts, NEW.hold_error)
     IS DISTINCT FROM (OLD.held_until, OLD.hold_attempted_at, OLD.hold_attempts, OLD.hold_error)
     AND NOT (crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system'
              AND (OLD.held_until IS NULL OR coalesce(NEW.held_until >= OLD.held_until, false))) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a retention hold is recorded by the system and never shortened';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.file_guard() FROM PUBLIC;

-- The files a posted journal entry stands on: today the original file of a recorded invoice
-- (crove_finance.purchase_document.source_file_id, purchases and sales alike). A file posted more than once (an invoice
-- recorded again after a reversal voided its first document) is held from its latest posting. retain_until is that
-- posting plus p_days, rounded up to the second (S3 keeps whole seconds). After a failed attempt the file waits 5
-- minutes, then 10, 20 and so on, at most a day; a file whose last attempt succeeded waits for nothing, so a longer
-- period lengthens its hold on the next run.
CREATE OR REPLACE FUNCTION crove_kernel.evidence_hold_due(p_days int, p_limit int)
RETURNS TABLE (org_id uuid, file_id uuid, storage_key text, generation text, sha256 text, retain_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH posted AS (
    SELECT d.org_id, d.source_file_id AS file_id, max(e.created_at) AS posted_at
      FROM crove_finance.purchase_document d
      JOIN crove_finance.journal_entry e
        ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
     WHERE d.source_file_id IS NOT NULL
     GROUP BY d.org_id, d.source_file_id
  ), wanted AS (
    SELECT p.org_id, p.file_id,
           pg_catalog.date_trunc('second', p.posted_at + pg_catalog.make_interval(days => p_days) + interval '999999 microseconds') AS retain_until
      FROM posted p
  )
  SELECT f.org_id, f.id, f.storage_key, f.generation, f.sha256, w.retain_until
    FROM wanted w
    JOIN crove_kernel.file f ON f.org_id = w.org_id AND f.id = w.file_id
    JOIN crove_kernel.tenant t ON t.org_id = f.org_id AND t.status IN ('active', 'offboarding')
   WHERE p_days > 0
     AND (f.held_until IS NULL OR f.held_until < w.retain_until)
     AND (f.hold_attempts = 0
          OR f.hold_attempted_at < pg_catalog.now() - LEAST(interval '1 day', interval '5 minutes' * pg_catalog.power(2, LEAST(f.hold_attempts - 1, 9))))
   ORDER BY f.hold_attempts, w.retain_until, f.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION crove_kernel.evidence_hold_due(int, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.evidence_hold_due(int, int) TO crove_worker;
