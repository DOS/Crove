-- crove_jobs (issue #1720, plan §4.9 "pg-boss contract"): a job that fails its last retry goes to the dead letter queue
-- kernel-job.dlq, whose worker raises the Inbox item kernel.job.dead_lettered in the job's org (the next migration and
-- apps/kernel/src/dead-letter.ts). Idempotent; applied files stay untouched.
--
-- pg-boss copies a job that failed after its last retry to its queue's dead letter queue (its data, singleton key and
-- group, and source_name, the queue it failed on), and keeps the failed job itself, which the prober counts
-- (crove_kernel.health). One dead letter queue for all, not one <queue>.dlq each: pg-boss works one queue per worker
-- loop, so 44 dead letter queues would poll 44 times as often for jobs that arrive a few times a month, and the copy
-- keeps its source queue anyway. A queue a later migration creates names it too (create_queue's deadLetter option);
-- apps/kernel/test/jobs.db.test.ts fails on one that does not. Jobs already queued keep no dead letter queue: pg-boss
-- stamps it on a job when the job is created.
SET LOCAL lock_timeout = '2s';

-- The dead letter queue: a few retries of its own, in case the database or the command is briefly unavailable.
SELECT crove_jobs.create_queue('kernel-job.dlq', '{"policy":"standard","retryLimit":5,"retryDelay":30,"retryBackoff":true}'::jsonb);

-- Every other queue sends its dead letters there. pg-boss reads the queue row when it creates a job, so jobs created
-- from now on carry it. A running worker's maintenance may hold a queue row for a moment, hence the retry.
DO $$
DECLARE
  n int := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
      UPDATE crove_jobs.queue SET dead_letter = 'kernel-job.dlq', updated_on = pg_catalog.now()
       WHERE name OPERATOR(pg_catalog.<>) 'kernel-job.dlq' AND dead_letter IS NULL;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      n := n + 1;
      IF n >= 15 THEN
        RAISE;
      END IF;
      PERFORM pg_catalog.pg_sleep(1 + pg_catalog.random());
    END;
  END LOOP;
END $$;
