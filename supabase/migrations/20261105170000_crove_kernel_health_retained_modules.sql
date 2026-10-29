-- The prober's job age keeps the queues of a worker that died, whatever the other workers work (issue #1887, from the
-- review of #1881). Idempotent; applied files stay untouched.
--
-- Before (20261105130000): health() counted the queues of the optional modules (finance, social, crm, notes) only
-- when a worker that beat in the last hour recorded the module. With replicas that run different CROVE_MODULES, a
-- finance-only worker that died dropped finance out of job age an hour later, while a kernel-only replica kept the
-- heartbeat fresh: a finance job queued after that never raised an alert.
--
-- After: a module counts when any heartbeat row of the last 7 days (the rows worker_beat keeps) records it. A worker
-- that stops cleanly (SIGTERM, as a redeploy or scale-down sends) beats once more with no modules (apps/kernel/src/
-- worker.ts), so a module the deployment leaves out on purpose drops out at once; a worker that dies without that
-- beat keeps its modules counted for 7 days, and its queued jobs raise job_age. A worker of an older release (no
-- modules recorded) that beat in the last hour still makes every queue count, as before.
--
-- crove_kernel.health(int)   as in 20261105130000, with the worked modules read from the last 7 days.
SET LOCAL lock_timeout = '2s';

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
  -- The modules the workers of the last 7 days recorded, a worker that stopped cleanly recording none; NULL (every
  -- queue counts) when none recorded any, or while a worker that beat in the last hour recorded none (an older release).
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
    WHERE h.beat_at > checked_at - interval '7 days';
  END IF;

  jobs_schema_present := pg_catalog.to_regclass('crove_jobs.job') IS NOT NULL;
  IF jobs_schema_present THEN
    -- Queued: waiting to run and already due (a retry waiting out its backoff is not late yet), in a queue a worker of
    -- the last 7 days works (#1877, #1887).
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM crove_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
        -- Only the queues of the optional modules can drop out; any other name counts, the kernel's and pg-boss's
        -- own (__pgboss__send-it, its cron) among them.
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'crm', 'notes'])
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_worked))
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
