-- A relay hold without walking the held backlog on every claim (issue #1713, a follow-up of #1696). Idempotent; applied
-- files stay untouched.
--
-- Before: while a 'relay:<event type>' kill switch was engaged, crove_kernel.outbox_claim and outbox_lag_seconds walked
-- every held row at the head of crove_kernel.outbox_pending (one outbox_event probe each) before they reached a row the
-- relay may claim, on every relay pass, so a long hold on a type orgs produce in bulk slowed the relay by the size of
-- its backlog.
--
-- After: the claim marks a held row the first time it meets it, in place: outbox_pending.held_type is set to the row's
-- event type. Marked rows sit apart in the index outbox_pending_held_seq (held_type, seq), so the claim and the lag walk
-- the unmarked rows only, in seq order, and pass a marked backlog of any size without touching it. A held row costs one
-- probe and one update once, not one probe per pass. The rows never leave outbox_pending: the org purge, the outbox
-- retention check, the prober's crove_kernel.health() and the held count of pnpm ops:kill-switch see them as before,
-- and crove_kernel.emit() and every other insert are untouched (a new row is unmarked).
--
-- A mark is only a cache of "this row's type was held when a claim met it". With no relay switch engaged, the claim and
-- the lag ignore marks altogether and run the same queries as before, so releasing the last hold drains every held row
-- at once, oldest first, with the rows of other types in seq order. While another type stays held, each claim first
-- clears the marks of every type that is no longer held (found by a walk over the distinct marked types, a few index
-- probes), then walks the queue: a released type's rows are back at the head of the queue, in their seq order. The lag
-- ages those rows too, so a stale mark never hides claimable work from the back-pressure.
--
-- What does not change: a held row is never deleted (only rows the claim found unheld and locked are); release drains a
-- type in seq order; each row is claimed once, by the relay transaction that deletes it and sends its jobs (#1705), and
-- a rolled-back batch rolls its marks back too; the back-pressure ignores held rows; the prober counts them. Order
-- between types is as in #1696: while a type is held, later events of other types relay before its earlier ones. As
-- today, rows another relay transaction has locked are skipped (SKIP LOCKED) and go out with a later batch.
--
-- crove_kernel.outbox_pending.held_type  the event type of a row a claim met while that type was held; NULL otherwise.
--                                        Written only by outbox_claim; nothing else reads it.
-- crove_kernel.outbox_marked_types()     the distinct held_type values, '{}' when none. Called by the two definers
--                                        below; no Crove role may call it.
-- crove_kernel.outbox_claim(limit)       as in 20261103110000, walking past marked rows.
-- crove_kernel.outbox_lag_seconds()      as in 20261103110000, walking past marked rows.
SET LOCAL lock_timeout = '2s';

-- A nullable column without a default changes only the catalog; the index is built under a SHARE lock, which holds new
-- outbox rows for the build of an index on the (short) pending queue. Both wait at most 2 s at a time for the lock.
DO $$
DECLARE
  n int := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
      ALTER TABLE crove_kernel.outbox_pending ADD COLUMN IF NOT EXISTS held_type text;
      CREATE INDEX IF NOT EXISTS outbox_pending_held_seq ON crove_kernel.outbox_pending (held_type, seq);
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

-- A loose index scan: one probe per distinct marked type, however many rows carry it.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_marked_types()
RETURNS text[] LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE t (held_type) AS (
    (SELECT p.held_type FROM crove_kernel.outbox_pending p WHERE p.held_type IS NOT NULL ORDER BY p.held_type LIMIT 1)
    UNION ALL
    SELECT (SELECT p.held_type FROM crove_kernel.outbox_pending p WHERE p.held_type > t.held_type ORDER BY p.held_type LIMIT 1)
    FROM t WHERE t.held_type IS NOT NULL
  )
  SELECT coalesce(pg_catalog.array_agg(t.held_type ORDER BY t.held_type), '{}'::text[]) FROM t WHERE t.held_type IS NOT NULL
$$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_marked_types() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.outbox_claim(p_limit int)
RETURNS TABLE (seq bigint, org_id uuid, event_id uuid, type text, payload jsonb, actor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_held text[] := crove_kernel.relay_held_types();
  v_stale text[];
  v_claim bigint[] := '{}';
  v_after bigint := 0; -- seq is an identity from 1
  v_want int;
  v_got int;
  v_type text;
  r record;
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
  -- The marks of a type released since a claim met its rows: those rows are claimable again, at their place in the
  -- queue. A row another relay transaction holds keeps its mark until a later pass.
  v_stale := ARRAY(SELECT m FROM pg_catalog.unnest(crove_kernel.outbox_marked_types()) m WHERE m <> ALL (v_held));
  IF pg_catalog.cardinality(v_stale) > 0 THEN
    UPDATE crove_kernel.outbox_pending p SET held_type = NULL
    WHERE p.seq IN (
      SELECT q.seq FROM crove_kernel.outbox_pending q WHERE q.held_type = ANY (v_stale) FOR UPDATE SKIP LOCKED
    );
  END IF;
  -- Walk the unmarked rows in seq order, a window of the rows still wanted at a time, so every row this locks is
  -- either claimed or marked: a row of a held type is marked and stays pending, every other row is claimed (one whose
  -- event is missing too, as before). A window shorter than asked for means the queue has no more unlocked rows.
  -- p_limit NULL claims every unheld row, as LIMIT NULL did; a negative one fails as LIMIT did.
  LOOP
    v_want := p_limit - pg_catalog.cardinality(v_claim);
    EXIT WHEN v_want = 0;
    v_got := 0;
    FOR r IN
      SELECT q.seq, q.org_id, q.event_id FROM crove_kernel.outbox_pending q
      WHERE q.held_type IS NULL AND q.seq > v_after
      ORDER BY q.held_type, q.seq LIMIT v_want FOR UPDATE SKIP LOCKED
    LOOP
      v_got := v_got + 1;
      v_after := r.seq;
      v_type := NULL;
      SELECT e.type INTO v_type FROM crove_kernel.outbox_event e WHERE e.org_id = r.org_id AND e.id = r.event_id;
      IF v_type = ANY (v_held) THEN
        UPDATE crove_kernel.outbox_pending p SET held_type = v_type WHERE p.seq = r.seq;
      ELSE
        v_claim := v_claim || r.seq;
      END IF;
    END LOOP;
    EXIT WHEN v_want IS NULL OR v_got < v_want;
  END LOOP;
  RETURN QUERY
  WITH claimed AS (
    DELETE FROM crove_kernel.outbox_pending p
    WHERE p.seq = ANY (v_claim)
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
  v_stale text[];
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'OUTBOX_LAG_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  v_held := crove_kernel.relay_held_types();
  IF pg_catalog.cardinality(v_held) = 0 THEN
    SELECT EXTRACT(EPOCH FROM pg_catalog.now() - e.created_at)::double precision INTO v_age
    FROM crove_kernel.outbox_pending p
    JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
    ORDER BY p.seq LIMIT 1;
    RETURN GREATEST(COALESCE(v_age, 0), 0);
  END IF;
  -- The oldest row the relay may claim: the first unmarked row of a type not held (unmarked held rows are only those
  -- emitted since the last claim), or the first row of a type marked and since released.
  v_stale := ARRAY(SELECT m FROM pg_catalog.unnest(crove_kernel.outbox_marked_types()) m WHERE m <> ALL (v_held));
  SELECT EXTRACT(EPOCH FROM pg_catalog.now() - x.created_at)::double precision INTO v_age
  FROM (
    (SELECT p.seq, e.created_at
     FROM crove_kernel.outbox_pending p
     JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id
     WHERE p.held_type IS NULL AND e.type <> ALL (v_held)
     ORDER BY p.held_type, p.seq LIMIT 1)
    UNION ALL
    (SELECT f.seq, e.created_at
     FROM pg_catalog.unnest(v_stale) s (t)
     CROSS JOIN LATERAL (
       SELECT p.seq, p.org_id, p.event_id FROM crove_kernel.outbox_pending p
       WHERE p.held_type = s.t ORDER BY p.held_type, p.seq LIMIT 1
     ) f
     JOIN crove_kernel.outbox_event e ON e.org_id = f.org_id AND e.id = f.event_id)
  ) x
  ORDER BY x.seq LIMIT 1;
  RETURN GREATEST(COALESCE(v_age, 0), 0);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.outbox_lag_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.outbox_lag_seconds() TO crove_worker;
