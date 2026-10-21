-- Image sizes for Social images uploaded before sizes were read at upload (issue #668). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.file_guard            as before, every column of a file row never changes, except that image_width and
--                                    image_height may go from both null to both set, once, in a system context: the
--                                    worker's backfill records the size it read from the file's header.
-- crove_kernel.image_size_due        the worker's scan, across active orgs, of Social images (JPEG, PNG, WebP, at most
--                                    25 MB) with no size yet, by id after a cursor, so a file whose header cannot be
--                                    read never holds the scan.
SET LOCAL lock_timeout = '2s';

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
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.file_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION crove_kernel.image_size_due(p_after uuid, p_limit int)
RETURNS TABLE (org_id uuid, file_id uuid, storage_key text, generation text, sha256 text, content_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT f.org_id, f.id, f.storage_key, f.generation, f.sha256, f.content_type
  FROM crove_kernel.file f
  JOIN crove_kernel.tenant t ON t.org_id = f.org_id AND t.status = 'active'
  WHERE f.source = 'social'
    AND f.content_type IN ('image/jpeg', 'image/png', 'image/webp')
    AND f.image_width IS NULL
    AND f.size_bytes <= 26214400
    AND f.id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY f.id
  LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;
REVOKE ALL ON FUNCTION crove_kernel.image_size_due(uuid, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.image_size_due(uuid, int) TO crove_worker;
