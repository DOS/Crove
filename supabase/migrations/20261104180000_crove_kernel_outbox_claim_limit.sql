-- outbox_claim refuses a NULL limit (issue #1782, from the review of #1774). Idempotent; applied files stay untouched.
--
-- Before (20261104020000_crove_kernel_relay_hold_mark.sql): p_limit NULL claimed every unheld row, as LIMIT NULL does.
-- While a relay switch was engaged, its walk then read the queue in one unbounded window, so the 10000-row marking cap,
-- checked between windows, never applied, and one pass could mark a whole held backlog and outlast the worker's
-- statement timeout. With no switch engaged it deleted the whole queue in one statement.
--
-- After: a NULL limit fails with OUTBOX_CLAIM_LIMIT_INVALID (22023) before the claim reads anything. No caller passes
-- one: the worker's relay and the load test claim 100 at a time. Everything else is as in 20261104020000: a negative
-- limit still fails as LIMIT does, 0 claims nothing, and the body is that migration's below the check, but for the
-- held types read after it and the walk's `v_want IS NULL` exit, which can no longer be taken.
--
-- crove_kernel.outbox_claim(limit)  as in 20261104020000, refusing a NULL limit.
CREATE OR REPLACE FUNCTION crove_kernel.outbox_claim(p_limit int)
RETURNS TABLE (seq bigint, org_id uuid, event_id uuid, type text, payload jsonb, actor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_held text[];
  v_stale text[];
  v_claim bigint[] := '{}';
  v_after bigint := 0; -- seq is an identity from 1
  v_want int;
  v_got int;
  v_marked int := 0;
  v_type text;
  r record;
BEGIN
  -- A NULL limit would read the queue in one unbounded window, past the marking cap below (#1782).
  IF p_limit IS NULL THEN
    RAISE EXCEPTION 'OUTBOX_CLAIM_LIMIT_INVALID' USING ERRCODE = '22023', DETAIL = 'outbox_claim takes a row limit, not NULL';
  END IF;
  v_held := crove_kernel.relay_held_types();
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
  -- queue. Each pass clears the oldest p_limit marked rows of each such type, so a pass stays short however large the
  -- backlog, and order within the type holds: the walk claims at most p_limit rows, and every row still marked comes
  -- after the p_limit cleared ones of its type. A row another relay transaction holds keeps its mark until a later pass.
  v_stale := ARRAY(SELECT m FROM pg_catalog.unnest(crove_kernel.outbox_marked_types()) m WHERE m <> ALL (v_held));
  IF pg_catalog.cardinality(v_stale) > 0 THEN
    UPDATE crove_kernel.outbox_pending p SET held_type = NULL
    WHERE p.seq IN (
      SELECT f.seq FROM pg_catalog.unnest(v_stale) s (t)
      CROSS JOIN LATERAL (
        SELECT q.seq FROM crove_kernel.outbox_pending q
        WHERE q.held_type = s.t
        ORDER BY q.held_type, q.seq LIMIT p_limit FOR UPDATE SKIP LOCKED
      ) f
    );
  END IF;
  -- Walk the unmarked rows in seq order, a window of the rows still wanted at a time, so every row this locks is
  -- either claimed or marked: a row of a held type is marked and stays pending, every other row is claimed (one whose
  -- event is missing too, as before). A window shorter than asked for means the queue has no more unlocked rows.
  -- A negative p_limit fails as LIMIT does. A pass marks about 10000 rows at most (checked between windows) and
  -- returns what it claimed so far, so engaging a switch on a large backlog commits its marks over several short passes
  -- instead of one that could outlast the worker's statement timeout.
  LOOP
    v_want := p_limit - pg_catalog.cardinality(v_claim);
    EXIT WHEN v_want = 0 OR v_marked >= 10000;
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
        v_marked := v_marked + 1;
      ELSE
        v_claim := v_claim || r.seq;
      END IF;
    END LOOP;
    EXIT WHEN v_got < v_want;
  END LOOP;
  IF pg_catalog.cardinality(v_claim) = 0 THEN
    RETURN;
  END IF;
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
