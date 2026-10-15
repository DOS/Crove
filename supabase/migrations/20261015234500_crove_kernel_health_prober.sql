-- Health checks for the Crove-owned alerting path (plan §4.13, issue #39). Idempotent; applied files stay untouched.
--
-- crove_prober             LOGIN role the `prober` image role connects as. Member of no role, owns nothing, and may
--                          do exactly one thing: execute crove_kernel.health(), which returns aggregate numbers
--                          (ages and counts) and no tenant data, org ids or payloads.
-- crove_kernel.worker_heartbeat  one row per worker instance, written every 30 s through worker_beat() (crove_worker
--                          only). Global machinery table without org_id: RLS on, no policy, no grants.
-- crove_kernel.health()    reads the relay backlog (outbox and inbound mail), the oldest queued job, failed jobs
--                          (pg-boss keeps a job whose retries are exhausted in state `failed`: Crove's dead letters)
--                          and the freshest worker heartbeat.
-- Its password is set by `migrate` from CROVE_PROBER_DB_PASSWORD, never here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crove_prober') THEN
    CREATE ROLE crove_prober LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  -- Drift guard: the prober only ever reads health().
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'crove_prober' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'role crove_prober must be LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = 'crove_prober'
  ) THEN
    RAISE EXCEPTION 'role crove_prober must not be a member of any role';
  END IF;
  -- Defense in depth only (health() is called schema-qualified and pins its own search_path). A runner without
  -- ADMIN on an existing crove_prober cannot alter it; the role then keeps what an earlier run set.
  IF pg_catalog.pg_has_role(current_user, 'crove_prober', 'MEMBER WITH ADMIN OPTION') THEN
    ALTER ROLE crove_prober SET search_path = pg_catalog, pg_temp;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Worker heartbeats
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.worker_heartbeat (
  instance text PRIMARY KEY CHECK (length(instance) BETWEEN 1 AND 128),
  beat_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON crove_kernel.worker_heartbeat FROM PUBLIC;
ALTER TABLE crove_kernel.worker_heartbeat ENABLE ROW LEVEL SECURITY;

-- Records that the worker `p_instance` is alive. Rows of instances silent for 7 days are removed, so recreated
-- containers (new host names) do not pile up.
CREATE OR REPLACE FUNCTION crove_kernel.worker_beat(p_instance text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at) VALUES (p_instance, pg_catalog.now())
  ON CONFLICT (instance) DO UPDATE SET beat_at = excluded.beat_at;
  DELETE FROM crove_kernel.worker_heartbeat WHERE beat_at < pg_catalog.now() - interval '7 days';
END $$;
REVOKE ALL ON FUNCTION crove_kernel.worker_beat(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text) TO crove_worker;

-- ---------------------------------------------------------------------------
-- Health
-- Ages are seconds (NULL when there is nothing to age); counts are capped at 10000 so a large backlog stays cheap.
-- p_dead_letter_window_seconds: failed jobs count when they failed within this many seconds (clamped to 60 s..7 d).
-- jobs_schema_present is false until `migrate` has created the pg-boss schema; the job columns are then NULL.
-- ---------------------------------------------------------------------------
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

  jobs_schema_present := pg_catalog.to_regclass('crove_jobs.job') IS NOT NULL;
  IF jobs_schema_present THEN
    -- Queued: waiting to run and already due (a retry waiting out its backoff is not late yet).
    SELECT pg_catalog.count(*)::int, EXTRACT(EPOCH FROM checked_at - pg_catalog.min(q.start_after))::double precision
    INTO jobs_queued, job_oldest_queued_age_seconds
    FROM (
      SELECT j.start_after FROM crove_jobs.job j
      WHERE j.state IN ('created', 'retry') AND j.start_after <= checked_at
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
GRANT USAGE ON SCHEMA crove_kernel TO crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.health(int) TO crove_prober;
