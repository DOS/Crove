-- Crove kernel (issue #1858, from the review of #1849): task_reroute moves a task only to a target seat it locked.
-- Idempotent; applied files stay untouched.
--
-- task_reroute (20261105000000) locked every target seat and its holder's membership, then moved the stranded tasks in
-- one UPDATE that read task_stranded again. A seat that became a target between the last locking read and that UPDATE
-- (a concurrent assignment of a seat between the stranded one and its old target) got tasks without being locked, so
-- the change of its holder could miss them. The UPDATE now moves only the tasks whose target is locked, or none (the
-- owners); the rest wait for the next round, which locks their targets first, until no stranded task has an unlocked
-- target. Each round's moves are answered together, and a deadlock retry (from the savepoint, which drops this
-- function's locks) starts the rounds again. Copied from 20261105000000 (the newest definition) with that change.
--
-- The deadlock this retry cannot break, with locks the calling command took before it (a seat FOR UPDATE, a member FOR
-- UPDATE), is avoided in the commands instead: every command that may re-route takes one lock per org first
-- (lockChartChanges, packages/kernel/src/task-reroute.ts), so two chart or role changes of an org run one after the
-- other.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.task_reroute(p_positions uuid[])
RETURNS TABLE (task_id uuid, from_position_id uuid, legal_entity_id uuid, to_position_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_locked uuid[];
  v_fresh uuid[];
  v_tries int := 0;
  v_ids uuid[];
  v_from uuid[];
  v_entities uuid[];
  v_to uuid[];
  v_step_ids uuid[];
  v_step_from uuid[];
  v_step_entities uuid[];
  v_step_to uuid[];
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (crove_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'TASK_REROUTE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  LOOP
    BEGIN
      v_locked := ARRAY[]::uuid[];
      v_ids := ARRAY[]::uuid[];
      v_from := ARRAY[]::uuid[];
      v_entities := ARRAY[]::uuid[];
      v_to := ARRAY[]::uuid[];
      LOOP
        LOOP
          SELECT pg_catalog.array_agg(DISTINCT s.to_position_id ORDER BY s.to_position_id) INTO v_fresh
          FROM crove_kernel.task_stranded(v_org, p_positions) s
          WHERE s.to_position_id IS NOT NULL AND NOT (s.to_position_id = ANY (v_locked));
          EXIT WHEN v_fresh IS NULL;
          PERFORM 1 FROM crove_kernel.position p WHERE p.org_id = v_org AND p.id = ANY (v_fresh) ORDER BY p.id FOR SHARE;
          PERFORM 1 FROM crove_kernel.tenant_member m
          WHERE m.org_id = v_org
            AND m.user_id IN (SELECT p.holder_user_id FROM crove_kernel.position p WHERE p.org_id = v_org AND p.id = ANY (v_fresh))
          ORDER BY m.user_id FOR SHARE;
          v_locked := v_locked || v_fresh;
        END LOOP;
        -- Only to a target locked above, or to the owners (no seat, #1858): a seat that became a target after the last
        -- read was never locked, so its tasks wait for the next round, which locks it first.
        WITH s AS (
            SELECT * FROM crove_kernel.task_stranded(v_org, p_positions) x
            WHERE x.to_position_id IS NULL OR x.to_position_id = ANY (v_locked)),
          moved AS (
            UPDATE crove_kernel.task t
            SET assignee_position_id = s.to_position_id,
                status = CASE WHEN t.status = 'in_progress' THEN 'todo' ELSE t.status END,
                checkout_run_id = NULL,
                lock_expires_at = NULL
            FROM s
            WHERE t.org_id = v_org AND t.id = s.task_id
            RETURNING t.id, s.from_position_id, t.legal_entity_id, s.to_position_id),
          noted AS (
            INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id)
            SELECT v_org, 'kernel.task', m.id, 'task.rerouted',
                   CASE WHEN m.to_position_id IS NULL
                        THEN 'Chuyển việc cho chủ sở hữu vì người giữ vị trí không còn xem được pháp nhân này'
                        ELSE 'Chuyển việc lên cấp trên vì người giữ vị trí không còn xem được pháp nhân này' END,
                   v_user
            FROM moved m)
        SELECT pg_catalog.array_agg(m.id ORDER BY m.id), pg_catalog.array_agg(m.from_position_id ORDER BY m.id),
               pg_catalog.array_agg(m.legal_entity_id ORDER BY m.id), pg_catalog.array_agg(m.to_position_id ORDER BY m.id)
          INTO v_step_ids, v_step_from, v_step_entities, v_step_to
        FROM moved m;
        v_ids := v_ids || coalesce(v_step_ids, ARRAY[]::uuid[]);
        v_from := v_from || coalesce(v_step_from, ARRAY[]::uuid[]);
        v_entities := v_entities || coalesce(v_step_entities, ARRAY[]::uuid[]);
        v_to := v_to || coalesce(v_step_to, ARRAY[]::uuid[]);
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM crove_kernel.task_stranded(v_org, p_positions) s
          WHERE s.to_position_id IS NOT NULL AND NOT (s.to_position_id = ANY (v_locked)));
      END LOOP;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      v_tries := v_tries + 1;
      IF v_tries > 1 THEN
        RAISE;
      END IF;
    END;
  END LOOP;
  -- Answered after the block, so a retried attempt never adds rows twice; in task id order across the rounds.
  RETURN QUERY SELECT r.t, r.f, r.e, r.o
    FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_from), pg_catalog.unnest(v_entities), pg_catalog.unnest(v_to)) AS r (t, f, e, o)
    ORDER BY r.t;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.task_reroute(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.task_reroute(uuid[]) TO crove_app;
