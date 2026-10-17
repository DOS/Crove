-- Video files for Social posts (Social plan S9, issue #409). Idempotent; applied files stay untouched.
--
-- crove_kernel.file.duration_ms  how long a video lasts, read by the server from the file itself (the MP4 or MOV
--                                movie header) when it is uploaded; null for every other file. Like every column of
--                                a file row it never changes afterwards (file_guard).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS duration_ms bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.file'::regclass AND conname = 'file_duration_ms_range') THEN
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_duration_ms_range CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000);
  END IF;
END $$;

-- The guard of 20261017140000, with the new column among those that never change.
CREATE OR REPLACE FUNCTION crove_kernel.file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.sha256, NEW.storage_key, NEW.generation, NEW.filename, NEW.content_type, NEW.size_bytes, NEW.source,
      NEW.created_by, NEW.created_at, NEW.duration_ms)
     IS DISTINCT FROM (OLD.id, OLD.sha256, OLD.storage_key, OLD.generation, OLD.filename, OLD.content_type, OLD.size_bytes,
      OLD.source, OLD.created_by, OLD.created_at, OLD.duration_ms) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a file reference (key, generation, sha256) never changes';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.file_guard() FROM PUBLIC;
