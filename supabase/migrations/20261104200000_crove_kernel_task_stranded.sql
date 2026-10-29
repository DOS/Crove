-- Crove kernel (issue #1799, from the review of #1788): the open tasks a chart or role change would strand go up the
-- chart. Idempotent; applied files stay untouched.
--
-- Since #1788 an agent hands a task of a legal entity only to a position whose holder reads it, but the check runs when
-- the task is written. A later change can leave an open task with a holder who cannot read it, so it is listed by
-- nobody but the owners: kernel.position.assign (another holder, or none), kernel.position.update (a narrower le_scope
-- for an agent's seat), kernel.member.role.assign and .revoke (a person's first entity assignment, or the org-wide one
-- revoked), kernel.member.change_role (an owner or admin made member or viewer) and kernel.member.remove (the seat left
-- vacant). Each of those commands, after its change, calls crove_kernel.task_reroute (packages/kernel/src/task-reroute.ts).
--
-- crove_kernel.task_stranded(org, positions)  The open tasks (todo, in_progress, waiting, in_review) of those positions
--     whose legal entity the position's holder no longer reads (position_reads_legal_entity, as #1788's checks read it),
--     each with its target: the entity-aware escalation target of #1788 (task_escalation_target, the nearest active
--     position up the chart held by a person who reads the entity), NULL for the owners at the root. Org-level tasks
--     (no entity) are never stranded. A helper of task_reroute: no EXECUTE for any login role.
-- crove_kernel.task_reroute(positions)  SECURITY DEFINER, EXECUTE for crove_app only. Moves those tasks, set-based, in
--     the caller's transaction, and answers each move:
--       - first it locks every target seat and its holder's membership (FOR SHARE, seats in id order, then members in
--         user order) and reads the answer again, until no target is left unlocked: a concurrent kernel.position.assign
--         or role change of a target waits, then sees the moved task and moves it in turn;
--       - then one UPDATE moves them (the target, or no seat; an agent's lease ends, an in-progress task is todo again)
--         and one INSERT writes an activity row task.rerouted per task, in the name of the context's user (it takes the
--         task's entity, b_legal_entity below), so a seat with thousands of open tasks costs two statements;
--       - a deadlock with another chart or role change (they lock seats and members in different orders) is retried
--         once from a savepoint, which drops the locks this function took; a second one is raised (the runtime answers
--         RETRY).
--     Only in a user context sealed as an owner of the org (the role at the start of the command, so an owner who
--     demotes themself, another owner staying, still re-routes their seats): every calling command is the owner's. It
--     reads #1788's worker-only helpers as their owner, so their EXECUTE matrix is unchanged, and writes only tasks and
--     activity of the sealed context's org, which an owner may write.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.task_stranded(p_org uuid, p_positions uuid[])
RETURNS TABLE (task_id uuid, from_position_id uuid, legal_entity_id uuid, to_position_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.id, t.assignee_position_id, t.legal_entity_id,
         crove_kernel.task_escalation_target(p_org, t.assignee_position_id, t.legal_entity_id)
  FROM crove_kernel.task t
  WHERE t.org_id = p_org
    AND t.assignee_position_id = ANY (p_positions)
    AND t.status IN ('todo', 'in_progress', 'waiting', 'in_review')
    AND t.legal_entity_id IS NOT NULL
    AND NOT crove_kernel.position_reads_legal_entity(p_org, t.assignee_position_id, t.legal_entity_id)
$$;
REVOKE ALL ON FUNCTION crove_kernel.task_stranded(uuid, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR (crove_kernel.ctx_verified() ->> 'role') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'TASK_REROUTE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  LOOP
    BEGIN
      v_locked := ARRAY[]::uuid[];
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
      WITH s AS (SELECT * FROM crove_kernel.task_stranded(v_org, p_positions)),
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
        INTO v_ids, v_from, v_entities, v_to
      FROM moved m;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      v_tries := v_tries + 1;
      IF v_tries > 1 THEN
        RAISE;
      END IF;
    END;
  END LOOP;
  -- Answered after the block, so a retried attempt never adds rows twice.
  RETURN QUERY SELECT * FROM pg_catalog.unnest(v_ids, v_from, v_entities, v_to);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.task_reroute(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.task_reroute(uuid[]) TO crove_app;

-- ---------------------------------------------------------------------------
-- crove_kernel.activity: a task's rows (task.rerouted, the first kernel.task rows) take its entity, so a member limited
-- to other entities never reads where a task of another went. The trigger's list from
-- 20261104010000_crove_kernel_proposal_legal_entity.sql, with kernel.task added; the function is unchanged. Only
-- tasks of an entity are moved (task_stranded), so every kernel.task row this file's commands write names one; a row
-- for an org-level task would take the writer's own entity when it is limited to exactly one (the function's NULL
-- branch), as for every other record type.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- record type, table, column holding the record id, column holding its entity (the trigger's arguments, in order)
  v_specs text[][] := ARRAY[
    ARRAY['finance.bank_account', 'crove_finance.bank_line', 'import_id', 'legal_entity_id'],
    ARRAY['finance.cash_voucher', 'crove_finance.cash_voucher', 'id', 'legal_entity_id'],
    ARRAY['finance.fixed_asset', 'crove_finance.fixed_asset', 'id', 'legal_entity_id'],
    ARRAY['finance.journal_entry', 'crove_finance.journal_entry', 'id', 'legal_entity_id'],
    ARRAY['finance.journal_voucher', 'crove_finance.journal_voucher', 'id', 'legal_entity_id'],
    ARRAY['finance.portal_invoice_list', 'crove_finance.portal_invoice_list', 'id', 'legal_entity_id'],
    ARRAY['finance.purchase_document', 'crove_finance.purchase_document', 'id', 'legal_entity_id'],
    ARRAY['kernel.legal_entity', 'crove_kernel.legal_entity', 'id', 'id'],
    ARRAY['kernel.proposal', 'crove_kernel.proposal', 'id', 'legal_entity_id'],
    ARRAY['kernel.task', 'crove_kernel.task', 'id', 'legal_entity_id']
  ];
  v_spec text[];
  v_args text := '';
BEGIN
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_args := v_args || CASE WHEN v_args = '' THEN '' ELSE ', ' END
      || pg_catalog.format('%L, %L, %L, %L', v_spec[1], v_spec[2], v_spec[3], v_spec[4]);
  END LOOP;
  -- No kernel.task row exists before this file (nothing wrote one), so there is nothing to backfill.
  DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.activity;
  EXECUTE pg_catalog.format(
    'CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_kernel.activity '
    'FOR EACH ROW EXECUTE FUNCTION crove_kernel.activity_legal_entity_fill(%s)', v_args);
END $$;
-- Also in replica mode, where ordinary triggers stay silent, so a row written there still gets its entity.
ALTER TABLE crove_kernel.activity ENABLE ALWAYS TRIGGER b_legal_entity;
