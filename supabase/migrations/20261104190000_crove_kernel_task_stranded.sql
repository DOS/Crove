-- Crove kernel (issue #1799, from the review of #1788): the open tasks a chart or role change would strand, and where
-- they go. Idempotent; applied files stay untouched.
--
-- Since #1788 an agent hands a task of a legal entity only to a position whose holder reads it, but the check runs when
-- the task is written. A later change can leave an open task with a holder who cannot read it, so it is listed by
-- nobody but the owners: kernel.position.assign (another holder, or none), kernel.position.update (a narrower le_scope
-- for an agent's seat), kernel.member.role.assign and .revoke (a person's first entity assignment, or the org-wide one
-- revoked), kernel.member.change_role (an owner or admin made member or viewer) and kernel.member.remove (the seat left
-- vacant). Each of those commands, after its change, re-routes those tasks (packages/kernel/src/task-reroute.ts).
--
-- crove_kernel.task_stranded(positions)  SECURITY DEFINER. The open tasks (todo, in_progress, waiting, in_review) of
--     those positions whose legal entity the position's holder no longer reads (position_reads_legal_entity, as
--     #1788's checks read it), each with its target: the entity-aware escalation target of #1788
--     (task_escalation_target, the nearest active position up the chart held by a person who reads the entity), NULL
--     for the owners at the root. Org-level tasks (no entity) are never stranded. Only in a user context of an owner of
--     the org, the role of every command that calls it: the helpers it uses are the worker's alone (#1788's EXECUTE
--     matrix, unchanged), and the definer reads them as their owner. It answers task ids and positions of the org of
--     the sealed context, which an owner reads anyway, and writes nothing: the command moves each task as the owner.
--     EXECUTE for crove_app only.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.task_stranded(p_positions uuid[])
RETURNS TABLE (task_id uuid, from_position_id uuid, legal_entity_id uuid, to_position_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner') THEN
    RAISE EXCEPTION 'TASK_STRANDED_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT t.id, t.assignee_position_id, t.legal_entity_id,
           crove_kernel.task_escalation_target(v_org, t.assignee_position_id, t.legal_entity_id)
    FROM crove_kernel.task t
    WHERE t.org_id = v_org
      AND t.assignee_position_id = ANY (p_positions)
      AND t.status IN ('todo', 'in_progress', 'waiting', 'in_review')
      AND t.legal_entity_id IS NOT NULL
      AND NOT crove_kernel.position_reads_legal_entity(v_org, t.assignee_position_id, t.legal_entity_id)
    ORDER BY t.id;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.task_stranded(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.task_stranded(uuid[]) TO crove_app;

-- ---------------------------------------------------------------------------
-- crove_kernel.activity: a task's rows (task.rerouted, the first kernel.task rows) take its entity, so a member limited
-- to other entities never reads where a task of another went. The trigger's list from
-- 20261104010000_crove_kernel_proposal_legal_entity.sql, with kernel.task added; the function is unchanged. An
-- org-level task (no entity) gives an org-level row, as the function leaves a NULL entity as it is.
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
