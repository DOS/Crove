-- The prober's job age counts the queues of the modules the deployment runs, whatever the workers record (issue
-- #1894, from the review of #1893). Idempotent; applied files stay untouched.
--
-- Before (20261105170000): an optional module's queues (finance, social, crm, notes) counted only while a heartbeat
-- row of the last 7 days recorded the module, and a worker that stops cleanly records none. When the only replica of
-- a module stopped cleanly (a rolling update, a node drain) and its replacement failed before its first beat, while
-- another replica kept the heartbeat fresh, the module dropped out at once and its queued jobs never alerted.
--
-- After: the prober tells health() which modules the deployment runs (its CROVE_MODULES, the same value as the API's
-- and the worker's) through the session setting crove.prober_modules, a comma-separated list
-- (apps/kernel/src/prober.ts). Those modules' queues always count. The setting only adds queues to the count, never
-- removes one: any other name in it, or no setting at all, leaves the count as 20261105170000 has it. No function,
-- grant or result column changes, so crove_prober still executes health(integer) and the alert gate alone.
--
-- crove_kernel.health(int)   as in 20261105170000, also counting the queues of the modules crove.prober_modules names.
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
  -- The modules the deployment runs, as the prober's session names them (#1894); empty when it names none.
  v_expected text[] := pg_catalog.string_to_array(COALESCE(pg_catalog.current_setting('crove.prober_modules', true), ''), ',');
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
    -- the last 7 days works or of a module the deployment runs (#1877, #1887, #1894).
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM crove_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
        -- Only the queues of the optional modules can drop out; any other name counts, the kernel's and pg-boss's
        -- own (__pgboss__send-it, its cron) among them.
        AND (v_worked IS NULL OR pg_catalog.split_part(j.name, '-', 1) <> ALL (ARRAY['finance', 'social', 'crm', 'notes'])
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_worked)
             OR pg_catalog.split_part(j.name, '-', 1) = ANY (v_expected))
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
