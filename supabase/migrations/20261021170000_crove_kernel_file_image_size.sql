-- Image sizes for Social posts (issue #636). Idempotent; applied files stay untouched.
--
-- crove_kernel.file.image_width, image_height  an image's size in pixels as it is shown (after its EXIF rotation),
--                                              read by the server from the file header (JPEG, PNG or WebP) when it
--                                              is uploaded for a post; null for every other file and for an image
--                                              uploaded before. Both or neither. Like every column of a file row
--                                              they never change afterwards (file_guard).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS image_width integer;
ALTER TABLE crove_kernel.file ADD COLUMN IF NOT EXISTS image_height integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.file'::regclass AND conname = 'file_image_size') THEN
    ALTER TABLE crove_kernel.file ADD CONSTRAINT file_image_size CHECK (
      (image_width IS NULL AND image_height IS NULL)
      OR (image_width BETWEEN 1 AND 100000 AND image_height BETWEEN 1 AND 100000)
    );
  END IF;
END $$;

-- The guard of 20261019130000, with the new columns among those that never change.
CREATE OR REPLACE FUNCTION crove_kernel.file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.sha256, NEW.storage_key, NEW.generation, NEW.filename, NEW.content_type, NEW.size_bytes, NEW.source,
      NEW.created_by, NEW.created_at, NEW.duration_ms, NEW.image_width, NEW.image_height)
     IS DISTINCT FROM (OLD.id, OLD.sha256, OLD.storage_key, OLD.generation, OLD.filename, OLD.content_type, OLD.size_bytes,
      OLD.source, OLD.created_by, OLD.created_at, OLD.duration_ms, OLD.image_width, OLD.image_height) THEN
    RAISE EXCEPTION 'FILE_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a file reference (key, generation, sha256) never changes';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.file_guard() FROM PUBLIC;
