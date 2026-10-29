-- The prober's job age counts only the queues a live worker works (issue #1877, from the review of #1875). Idempotent;
-- applied files stay untouched.
--
-- Before: crove_kernel.health() aged every queued job. A deployment that leaves a module out (CROVE_MODULES, ADR-0031)
-- does not work that module's queues, so a job an earlier run with the module queued (a social publish, a crm booking
-- mail, a finance extraction, a notes member purge) waited forever and the prober's job_age check reported the workers
-- stuck, though nothing was.
--
-- After: each worker records, with its heartbeat, the modules it works (worker_heartbeat.modules, through the new
-- worker_beat(text, text[])). health() leaves out of jobs_queued and job_oldest_queued_age_seconds the jobs of a queue
-- whose module no worker that beat in the last hour works; a queue's module is its name up to the first '-' (kernel-,
-- finance-, social-, crm-, notes-; apps/kernel/test/jobs-schema.test.ts holds every queue to that). The kernel's
-- queues always count. While any worker that beat in the last hour has not recorded its modules (an older release
-- during a deploy), every queue counts, as before. Nothing is deleted: the jobs stay queued, and run once the module is
-- installed again (the notes member purge carries whose notes to purge). The dead letter count is unchanged.
--
-- crove_kernel.worker_heartbeat.modules   the modules the worker works, kernel included; NULL for an older worker.
-- crove_kernel.worker_beat(text, text[])  as worker_beat(text), recording the modules too (crove_worker only).
-- crove_kernel.health(int)                as in 20261015234500, leaving out the queues of modules no live worker works.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.worker_heartbeat ADD COLUMN IF NOT EXISTS modules text[];

-- Records that the worker `p_instance` is alive and which modules it works. Module names are lowercase words (as
-- CROVE_MODULES has them), at most 32 of them.
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
  ON CONFLICT (instance) DO UPDATE SET beat_at = excluded.beat_at, modules = excluded.modules;
  DELETE FROM crove_kernel.worker_heartbeat WHERE beat_at < pg_catalog.now() - interval '7 days';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.worker_beat(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text, text[]) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.health(p_dead_letter_window_seconds int DEFAULT 3600)
RETURNS TABLE (
  checked_at timestamptz,
  outbox_pending int,
  outbox_oldest_age_seconds double precision,
  inbound_pending int,
  inbound_oldest_age_seconds double precision,
  jobs_schema_present boolean,
  jobs_queued int,
  job_oldest_queued_age_seconds double precision,
  dead_letter_count int,
  worker_heartbeat_age_seconds double precision
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_window interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_dead_letter_window_seconds, 3600), 60), 604800));
  -- The modules the workers that beat in the last hour work; NULL (every queue counts) when none recorded them, or
  -- when one of them did not (an older release).
  v_worked text[];
BEGIN
  checked_at := pg_catalog.now();

  SELECT pg_catalog.count(*)::int INTO outbox_pending
  FROM (SELECT 1 FROM crove_kernel.outbox_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - e.created_at)::double precision INTO outbox_oldest_age_seconds
  FROM crove_kernel.outbox_pending p
  JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
  ORDER BY p.seq LIMIT 1;

  SELECT pg_catalog.count(*)::int INTO inbound_pending
  FROM (SELECT 1 FROM crove_kernel.inbound_pending LIMIT 10000) s;
  SELECT EXTRACT(EPOCH FROM checked_at - i.received_at)::double precision INTO inbound_oldest_age_seconds
  FROM crove_kernel.inbound_pending i ORDER BY i.seq LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM crove_kernel.worker_heartbeat h WHERE h.beat_at > checked_at - interval '1 hour' AND h.modules IS NULL) THEN
    SELECT pg_catalog.array_agg(DISTINCT m) INTO v_worked
    FROM crove_kernel.worker_heartbeat h, pg_catalog.unnest(h.modules) m
    WHERE h.beat_at > checked_at - interval '1 hour';
  END IF;

  jobs_schema_present := pg_catalog.to_regclass('crove_jobs.job') IS NOT NULL;
  IF jobs_schema_present THEN
    -- Queued: waiting to run and already due (a retry waiting out its backoff is not late yet), in a queue a live
    -- worker works (#1877).
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM crove_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) = 'kernel' OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_worked))
      ORDER BY j.start_after LIMIT 10000
    ) q;
    SELECT pg_catalog.count(*)::int INTO dead_letter_count
    FROM (
      SELECT 1 FROM crove_jobs.job j
      WHERE j.state = 'failed' AND COALESCE(j.completed_on, j.created_on) > checked_at - v_window
      LIMIT 10000
    ) d;
  END IF;

  SELECT EXTRACT(EPOCH FROM checked_at - pg_catalog.max(h.beat_at))::double precision INTO worker_heartbeat_age_seconds
  FROM crove_kernel.worker_heartbeat h;

  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.health(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.health(int) TO crove_prober;
