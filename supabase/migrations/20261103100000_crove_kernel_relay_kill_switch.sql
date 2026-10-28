-- A kill switch per relay type (issue #1696, plan §4.12 "Kill switches": checked at the relay per type; Phase 1 exit
-- criterion 8). Idempotent; applied files stay untouched.
--
-- The operator's deployment-wide switch (crove_kernel.global_kill_switch, #886) had the keys 'ai' and 'mail'. It now
-- also takes 'relay:<event type>' (for example 'relay:kernel.file.ingested'): while one is engaged the worker's relay
-- leaves the outbox events of that type where they are and relays every other type, so a type whose jobs misbehave
-- (a provider that must not be called, a job that crashes the worker) stops without stopping the rest. Releasing the
-- switch drains them: the rows were never claimed, so the next relay pass (at most a second later) sends them, in
-- order, with the singleton keys they always had. Engaging or releasing takes effect from the next claim; a relay
-- transaction already in flight sends what it claimed.
--
-- While a type is held, each claim walks the held rows at the head of the outbox (one outbox_event probe each) before
-- it reaches claimable ones, so a long hold on a type tenants produce in bulk slows the relay; holds are meant to be
-- short (incidents runbook §7).
--
-- The table, its RLS, its grants and its break-glass path stay as they were: only the database owner flips a key,
-- through crove_kernel.global_kill_switch_set (pnpm ops:kill-switch), and every change is a row of the append-only
-- history with when, who and why. That row is the switch's audit trail; the switch belongs to no org, so it has no
-- crove_kernel.audit_event row (plan §3.6 control-plane data).
--
-- crove_kernel.relay_held_types()      the event types whose relay switch is engaged now, '{}' when none. Called by the
--                                      two definers below; no Crove role may call it.
-- crove_kernel.outbox_claim(limit)     as in the bootstrap, and skips the rows of a held type. With no relay switch
--                                      engaged it runs the same query as before.
-- crove_kernel.outbox_lag_seconds()    as in 20261027230000, and ages only the rows the relay may claim, so a held
--                                      backlog does not pause the agent, bulk mail and archive queues. The prober's
--                                      crove_kernel.health() still ages every pending row: work is waiting, and its
--                                      alert keeps reminding the operator to release the switch.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.global_kill_switch DROP CONSTRAINT IF EXISTS global_kill_switch_key_check;
ALTER TABLE crove_kernel.global_kill_switch ADD CONSTRAINT global_kill_switch_key_check CHECK (
  key IN ('ai', 'mail')
  OR (length(key) <= 200 AND key ~ '^relay:[a-z0-9_]+(\.[a-z0-9_]+)+$')
);

CREATE OR REPLACE FUNCTION crove_kernel.relay_held_types()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.array_agg(pg_catalog.substr(s.key, 7) ORDER BY s.key), '{}'::text[])
  FROM (
    SELECT DISTINCT ON (g.key) g.key, g.engaged
    FROM crove_kernel.global_kill_switch g
    WHERE g.key LIKE 'relay:%'
    ORDER BY g.key, g.changed_at DESC, g.id DESC
  ) s
  WHERE s.engaged
$$;
REVOKE ALL ON FUNCTION crove_kernel.relay_held_types() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.outbox_claim(p_limit int)
RETURNS TABLE (seq bigint, org_id uuid, event_id uuid, type text, payload jsonb, actor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_held text[] := crove_kernel.relay_held_types();
BEGIN
  IF pg_catalog.cardinality(v_held) = 0 THEN
    RETURN QUERY
    WITH claimed AS (
      DELETE FROM crove_kernel.outbox_pending p
      WHERE p.seq IN (
        SELECT q.seq FROM crove_kernel.outbox_pending q ORDER BY q.seq LIMIT p_limit FOR UPDATE SKIP LOCKED
      )
      RETURNING p.seq, p.org_id, p.event_id
    )
    SELECT c.seq, c.org_id, c.event_id, e.type, e.payload, e.actor_id
    FROM claimed c JOIN crove_kernel.outbox_event e ON e.org_id = c.org_id AND e.id = c.event_id
    ORDER BY c.seq;
    RETURN;
  END IF;
  -- A held type's rows stay pending, unlocked, for the relay pass after the switch is released.
  RETURN QUERY
  WITH claimed AS (
    DELETE FROM crove_kernel.outbox_pending p
    WHERE p.seq IN (
      SELECT q.seq FROM crove_kernel.outbox_pending q
      LEFT JOIN crove_kernel.outbox_event h ON h.org_id = q.org_id AND h.id = q.event_id
      WHERE h.type IS NULL OR h.type <> ALL (v_held)
      ORDER BY q.seq LIMIT p_limit FOR UPDATE OF q SKIP LOCKED
    )
    RETURNING p.seq, p.org_id, p.event_id
  )
  SELECT c.seq, c.org_id, c.event_id, e.type, e.payload, e.actor_id
  FROM claimed c JOIN crove_kernel.outbox_event e ON e.org_id = c.org_id AND e.id = c.event_id
  ORDER BY c.seq;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_claim(int) FROM PUBLIC, crove_tenant, crove_app, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_claim(int) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.outbox_lag_seconds()
RETURNS double precision LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_age double precision;
  v_held text[];
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'OUTBOX_LAG_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  v_held := crove_kernel.relay_held_types();
  SELECT EXTRACT(EPOCH FROM pg_catalog.now() - e.created_at)::double precision INTO v_age
  FROM crove_kernel.outbox_pending p
  JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
  WHERE e.type <> ALL (v_held)
  ORDER BY p.seq LIMIT 1;
  RETURN GREATEST(COALESCE(v_age, 0), 0);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_lag_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_lag_seconds() TO crove_worker;
