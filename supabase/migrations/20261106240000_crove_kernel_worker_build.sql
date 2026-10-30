-- Crove kernel (issue #1952, plan §3.5 "worker build >= API build"): workers record the build they run, and the API's
-- /readyz fails while a live worker runs an older build. Idempotent; applied files stay untouched.
--
-- crove_kernel.worker_heartbeat gains build (CROVE_BUILD, the image's git SHA) and build_time (CROVE_BUILD_TIME, the
-- committer date of that SHA). A SHA has no order, so builds are compared by build_time: main is merged one squash
-- commit at a time, so committer dates rise along it, and an older commit rebuilt for a rollback keeps its own date.
--
-- crove_kernel.worker_beat(text, text[], text, timestamptz)  the beat of this release: the instance, its modules, its
--     build and build time (both NULL for a local build). crove_worker only, as the other overloads.
-- crove_kernel.worker_beat(text, text[]) and (text)  an older release's beat (a rollback on the same host, whose row a
--     newer release already wrote) clears the build as it clears or keeps the modules, so its row reads as a worker of
--     unknown build, which the API counts as older.
-- crove_kernel.worker_build_lag(timestamptz)  for the API's /readyz (crove_app only): how many workers are live (a beat
--     in the last 90 seconds, three beats, and not the empty module list a clean stop sends last, #1887) and how many
--     of them run a build older than p_build_time or of unknown build time. Counts only: no instance names or builds
--     reach the API's role.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.worker_heartbeat ADD COLUMN IF NOT EXISTS build text;
ALTER TABLE crove_kernel.worker_heartbeat ADD COLUMN IF NOT EXISTS build_time timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'worker_heartbeat_build_check' AND conrelid = 'crove_kernel.worker_heartbeat'::regclass) THEN
    ALTER TABLE crove_kernel.worker_heartbeat ADD CONSTRAINT worker_heartbeat_build_check CHECK (build ~ '^[A-Za-z0-9._-]{1,64}$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.worker_beat(p_instance text, p_modules text[], p_build text, p_build_time timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_modules IS NULL OR pg_catalog.cardinality(p_modules) > 32
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_modules) m WHERE m IS NULL OR m !~ '^[a-z][a-z0-9_]{0,31}$') THEN
    RAISE EXCEPTION 'WORKER_BEAT_MODULES_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_build IS NOT NULL AND p_build !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'WORKER_BEAT_BUILD_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at, modules, build, build_time)
  VALUES (p_instance, pg_catalog.now(), p_modules, p_build, p_build_time)
  ON CONFLICT (instance) DO UPDATE
    SET beat_at = excluded.beat_at, modules = excluded.modules, build = excluded.build, build_time = excluded.build_time;
  DELETE FROM crove_kernel.worker_heartbeat WHERE beat_at < pg_catalog.now() - interval '7 days';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.worker_beat(text, text[], text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text, text[], text, timestamptz) TO crove_worker;

-- As 20261105130000 left them, but an older release's beat also clears the build.
CREATE OR REPLACE FUNCTION crove_kernel.worker_beat(p_instance text, p_modules text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_modules IS NULL OR pg_catalog.cardinality(p_modules) > 32
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_modules) m WHERE m IS NULL OR m !~ '^[a-z][a-z0-9_]{0,31}$') THEN
    RAISE EXCEPTION 'WORKER_BEAT_MODULES_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at, modules) VALUES (p_instance, pg_catalog.now(), p_modules)
  ON CONFLICT (instance) DO UPDATE SET beat_at = excluded.beat_at, modules = excluded.modules, build = NULL, build_time = NULL;
  DELETE FROM crove_kernel.worker_heartbeat WHERE beat_at < pg_catalog.now() - interval '7 days';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.worker_beat(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text, text[]) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.worker_beat(p_instance text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at) VALUES (p_instance, pg_catalog.now())
  ON CONFLICT (instance) DO UPDATE SET beat_at = excluded.beat_at, modules = NULL, build = NULL, build_time = NULL;
  DELETE FROM crove_kernel.worker_heartbeat WHERE beat_at < pg_catalog.now() - interval '7 days';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.worker_beat(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.worker_build_lag(p_build_time timestamptz)
RETURNS TABLE (live int, older int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.count(*)::int,
         pg_catalog.count(*) FILTER (WHERE h.build_time IS NULL OR h.build_time < p_build_time)::int
  FROM crove_kernel.worker_heartbeat h
  WHERE h.beat_at > pg_catalog.now() - interval '90 seconds'
    AND (h.modules IS NULL OR pg_catalog.cardinality(h.modules) > 0)
$$;
REVOKE ALL ON FUNCTION crove_kernel.worker_build_lag(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.worker_build_lag(timestamptz) TO crove_app;
