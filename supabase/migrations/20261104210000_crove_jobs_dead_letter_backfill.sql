-- crove_jobs: jobs queued before the dead letter queue get it too (issue #1780, left from #1720). Idempotent; applied
-- files stay untouched.
--
-- 20261103150000_crove_jobs_dead_letter.sql named kernel-job.dlq as every queue's dead letter queue, but pg-boss stamps
-- a job's dead letter queue on the job when it is created, from its queue's row. A job created before that migration
-- and still waiting (created), waiting for its next try (retry) or running (active) has none, so if it fails its last
-- retry nothing reaches the dead letter queue and its org gets no Inbox item; only the prober's failed-job count sees
-- it. This stamps those jobs with their queue's dead letter queue, as pg-boss would have when it created them.
--
-- Live job rows: the worker locks a job row while it fetches or finishes it, so the update waits for those rows a
-- moment; each try waits 2 s at most for a lock and the block tries again, as the queue update of 20261103150000 does.
-- A job that finishes meanwhile is left as it ends (completed, failed, cancelled: never stamped). Jobs created from now
-- on carry the queue's dead letter queue already, so the update finds fewer rows every time it runs; on a database
-- where every job is newer, it changes nothing.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  n int := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
      UPDATE crove_jobs.job j SET dead_letter = q.dead_letter
        FROM crove_jobs.queue q
       WHERE q.name OPERATOR(pg_catalog.=) j.name AND q.dead_letter IS NOT NULL AND j.dead_letter IS NULL
         AND j.state OPERATOR(pg_catalog.=) ANY (ARRAY['created', 'retry', 'active']::crove_jobs.job_state[]);
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
