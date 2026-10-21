-- The agent write guard on pg-boss's tables too (issue #333, item 1). Idempotent; applied files stay untouched.
--
-- 20261019010000 put crove_kernel.agent_write_guard on every crove_* table but crove_meta and crove_jobs, and named
-- the gap: the worker login role writes crove_jobs, and an agent transaction runs on the worker's connections, so raw
-- SQL in an agent context could have enqueued, completed or deleted jobs. Nothing legitimate writes crove_jobs in an
-- agent context: commands emit outbox events and the worker relays them to pg-boss on its own connections, outside
-- any context. So every crove_jobs table now carries the guard, which refuses any row an agent context writes there
-- (AGENT_FORBIDDEN) and passes every other write unchanged; without a sealed context the guard returns at its first
-- check, so pg-boss's own traffic pays one setting read per row.
--
-- crove_jobs.job is partitioned by queue and queue_stats by day. A row trigger on a partitioned table is cloned onto
-- each partition, including those created or attached later (crove_jobs.create_queue, run by the migrations that add
-- a queue, and the stats partitions pg-boss creates as it runs), so the install below covers those to come. A
-- vendored pg-boss upgrade that adds a table must install the guard on it; the invariant suite fails on a crove_jobs
-- table without it.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  r record;
BEGIN
  IF pg_catalog.to_regnamespace('crove_jobs') IS NULL THEN
    RAISE EXCEPTION 'crove_jobs is missing: the vendored pg-boss schema must come first';
  END IF;
  FOR r IN
    SELECT c.oid::regclass AS t
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_jobs' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    PERFORM crove_kernel.agent_write_guard_install(r.t);
  END LOOP;
END $$;
