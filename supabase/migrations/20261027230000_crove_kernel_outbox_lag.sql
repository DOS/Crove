-- Outbox lag for the worker's back-pressure (plan §4.9 "Back-pressure", issue #894). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.outbox_lag_seconds()  the age in seconds of the oldest unpublished outbox event, 0 when none waits.
--                          crove_worker only, and it refuses any other session even with EXECUTE granted by mistake.
--                          One number across orgs: no org id, event or payload leaves it. While it is above
--                          OUTBOX_LAG_PAUSE_SECONDS the worker stops fetching agent, bulk mail and archive jobs.

CREATE OR REPLACE FUNCTION crove_kernel.outbox_lag_seconds()
RETURNS double precision LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_age double precision;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'OUTBOX_LAG_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT EXTRACT(EPOCH FROM pg_catalog.now() - e.created_at)::double precision INTO v_age
  FROM crove_kernel.outbox_pending p
  JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
  ORDER BY p.seq LIMIT 1;
  RETURN GREATEST(COALESCE(v_age, 0), 0);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_lag_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_lag_seconds() TO crove_worker;
