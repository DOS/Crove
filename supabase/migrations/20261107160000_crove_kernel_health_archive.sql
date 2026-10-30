-- SPDX-License-Identifier: AGPL-3.0-only
-- The prober sees the WORM archive (issue #1997): the nightly verification that stopped running, or the archive that
-- fell behind, alert like a stuck worker instead of waiting for someone to run the runbook's queries by hand
-- (docs/runbooks/worm-archive.md). Idempotent; applied files stay untouched.
--
-- crove_kernel.health(int)   as in 20261106030000, with two more columns at the end:
--   archive_verify_age_seconds  seconds since the newest crove_kernel.archive_verification run, or, before the first,
--                               since the first archive batch was written; NULL while the archive holds no batch.
--   archive_lag_seconds         the age of the oldest audit event or journal entry not yet in an archive batch; NULL
--                               when every row is anchored.
-- Both are aggregates over tables that hold no tenant data in what is returned (times only). Each is one index lookup
-- (archive_verification_time_idx, archive_batch's primary key, audit_event_occurred_idx) or a BRIN range scan from the
-- newest batch's end (journal_entry_created_brin), whose cost grows only with the rows not yet archived (the same scan
-- the archiver runs every minute), so health() stays fast.
--
-- A function's result columns cannot change in place, so it is dropped and created again, with the same grant:
-- EXECUTE for crove_prober alone. The invariant suite accepts both column lists since #2024 (step 1).
SET LOCAL lock_timeout = '2s';

DROP FUNCTION IF EXISTS crove_kernel.health(int);
CREATE FUNCTION crove_kernel.health(p_dead_letter_window_seconds int DEFAULT 3600)
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
  worker_heartbeat_age_seconds double precision,
  archive_verify_age_seconds double precision,
  archive_lag_seconds double precision
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_window interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_dead_letter_window_seconds, 3600), 60), 604800));
  -- The modules the workers of the last 7 days recorded, a worker that stopped cleanly recording none; NULL (every
  -- queue counts) when none recorded any, or while a worker that beat in the last hour recorded none (an older release).
  v_worked text[];
  -- The modules the deployment runs, as the prober's session names them (#1894); empty when it names none.
  v_expected text[] := pg_catalog.string_to_array(COALESCE(pg_catalog.current_setting('crove.prober_modules', true), ''), ',');
  -- The end of the newest archive batch: rows from there on are not anchored yet.
  v_archived_to timestamptz;
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

  -- The nightly verification of the WORM archive (#1997): the age of the newest run, or, before the first run, of the
  -- first batch (the verifier owes a run within a day of it); NULL while the archive holds no batch. Index lookups only.
  SELECT EXTRACT(EPOCH FROM checked_at - COALESCE(
           (SELECT v.verified_at FROM crove_kernel.archive_verification v ORDER BY v.verified_at DESC LIMIT 1),
           (SELECT b.written_at FROM crove_kernel.archive_batch b ORDER BY b.seq LIMIT 1)))::double precision
    INTO archive_verify_age_seconds;
  -- How far the archive is behind (#1997): the age of the oldest audit event or journal entry not yet in a batch, the
  -- times the archiver cuts windows by; NULL when every row is anchored. It normally stays near ARCHIVE_LAG_SECONDS
  -- (600 s), which the archiver waits so an open transaction is not cut off. One row from each table's time index,
  -- read from the newest batch's end on.
  SELECT b.window_to INTO v_archived_to FROM crove_kernel.archive_batch b ORDER BY b.seq DESC LIMIT 1;
  SELECT EXTRACT(EPOCH FROM checked_at - LEAST(
           (SELECT a.occurred_at FROM crove_kernel.audit_event a WHERE a.occurred_at >= COALESCE(v_archived_to, '-infinity') ORDER BY a.occurred_at LIMIT 1),
           (SELECT e.created_at FROM crove_finance.journal_entry e WHERE e.created_at >= COALESCE(v_archived_to, '-infinity') ORDER BY e.created_at LIMIT 1)))::double precision
    INTO archive_lag_seconds;

  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.health(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.health(int) TO crove_prober;
