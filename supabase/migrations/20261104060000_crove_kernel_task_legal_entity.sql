-- Crove kernel (issue #1762, plan §4.6 RLS "a RESTRICTIVE legal-entity-scope policy on every table with
-- legal_entity_id", kernel tables included, Phase 1 exit criterion 2): tasks and their comments are scoped per legal
-- entity for the records that belong to one. Idempotent; applied files stay untouched.
--
-- Before this file tasks were read org-wide (kernel.task.list and kernel.task.get, access ALL), so a member limited to
-- entity A read what a task says about entity B's records: the review comment and the escalation reason list the failed
-- and warning check messages of a proposal (modules/finance/src/agent.ts), and people and agents write free text about
-- one entity's records. Since #1538 the proposal itself is read only within its entity.
--
-- crove_kernel.task gets a nullable legal_entity_id, a foreign key to the org's legal entity, an index on
-- (legal_entity_id, org_id) (G3 fk-index) and the RESTRICTIVE policy le_scope that lets NULL through, the predicate of
-- crove_kernel.activity (20261103120000, #1716): NULL is an org-level task every member of the org keeps reading; a task
-- with an entity is read and written only by an actor whose sealed context's le_scope names that entity ('*' every
-- entity). Agents read through the same policy with their position's scope (#1538).
--
-- Which tasks get an entity (trigger task_legal_entity, crove_kernel.task_legal_entity_fill, BEFORE INSERT OR UPDATE OF
-- legal_entity_id, ENABLE ALWAYS). It runs after task_before_insert (trigger names in order), which keeps the T18 agent
-- rules (lease, taint, creator) unchanged.
--   - A delegated or escalated task (parent_task_id) takes its parent's entity, read as the writer. A writer limited to
--     some entities that cannot read the parent (another entity's task) is refused with LEGAL_ENTITY_MISMATCH: the
--     child would otherwise be org-level. Any other writer that cannot read it (scope '*', or no context) names another
--     org's task or none, which the tenant policy or the foreign key refuses. An agent never gets here: it creates a
--     child only of a task its run holds, or task_before_insert refuses it with AGENT_LEASE_REQUIRED.
--   - Otherwise a task whose source_ref names a record of one entity takes the record's entity: the trigger's arguments
--     list, in threes, a record type, the table that holds such records and the column that holds its entity (the
--     record's id is the table's id column). The listed types are activity's (20261104010000) whose record id is the
--     record's own id: kernel.proposal (the review tasks dispatch creates), kernel.legal_entity and the finance
--     records. The record is read as the writer (SECURITY INVOKER); when the writer cannot read it, the task takes the
--     writer's own entity when its scope is exactly one entity, as activity does, and is refused (LEGAL_ENTITY_MISMATCH)
--     for a writer limited to several; a writer with every entity ('*') or no context names another org's record or
--     none, and the task stays org-level.
--     source_ref is never a caller's input (kernel.task.create names none; kernel code sets it).
--   - Otherwise (no parent, no listed record: a person's task, a to-do handed over, a social post) NULL, org-level.
--   - A writer that names an entity keeps it when no rule above gives one (le_scope's WITH CHECK and the foreign key
--     still apply); a different entity than the rule's is refused (LEGAL_ENTITY_MISMATCH).
--   - legal_entity_id never changes once written (LEGAL_ENTITY_IMMUTABLE): no command writes it, and
--     task_before_update already refuses any change but lease and status from an agent.
--
-- crove_kernel.task_comment follows its task: the RESTRICTIVE policy task_scope reads and writes a comment only when
-- its task is visible to the actor, through the task's own policies (tenant and le_scope). No second column to keep in
-- step, and no comment can be written on a task its writer cannot read.
--
-- No stream hint: crove_kernel.task has no stream_hint trigger, so ENTITY_HINT_TYPES (apps/kernel/src/stream.ts) stays.
--
-- The backfill, as the migration runner (the table's owner, which RLS does not filter), before the triggers exist:
--   1. tasks still NULL whose source_ref names a listed record take its entity, joined on the record's key;
--   2. a child takes its parent's entity when the parent has one, repeated down the chain (request_depth is at most
--      5), so every task ends as the trigger would have stamped it;
--   3. review and escalation tasks created before #1756 lose the proposal's title they copied: "Rà soát đề xuất:
--      <title>" becomes "Rà soát đề xuất chờ duyệt" and "Duyệt đề xuất: <title>" becomes "Duyệt đề xuất đã rà soát",
--      the wording #1756 writes (packages/kernel/src/agents.ts, modules/finance/src/agent.ts). Their descriptions and
--      review comments (append-only) keep their text, now behind the proposal's entity.
-- task_before_update, which stamps updated_at, is disabled around these UPDATEs only, so the tasks keep their order.
-- Every step touches only rows it would change. The migration runner applies a file once; a manual rerun on a live
-- database would also stamp tasks the trigger left org-level because their writer could not read the record.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.task ADD COLUMN IF NOT EXISTS legal_entity_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 WHERE c.conrelid = 'crove_kernel.task'::regclass AND c.conname = 'task_legal_entity_fk') THEN
    ALTER TABLE crove_kernel.task ADD CONSTRAINT task_legal_entity_fk
      FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id);
  END IF;
END $$;
-- The foreign key's index (G3 fk-index), entity first, as in 20261103120000.
CREATE INDEX IF NOT EXISTS task_legal_entity_idx ON crove_kernel.task (legal_entity_id, org_id);

-- BEFORE INSERT OR UPDATE OF legal_entity_id. Arguments: threes of (record type, table, column holding its entity).
-- SECURITY INVOKER: it reads the parent and the record as the writer, so it learns nothing the writer could not read.
CREATE OR REPLACE FUNCTION crove_kernel.task_legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
  v_found boolean := false;
  v_scope text[];
  v_type text;
  v_id text;
  i int := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_IMMUTABLE' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.task')::text;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT t.legal_entity_id, true INTO v_entity, v_found
    FROM crove_kernel.task t WHERE t.org_id = NEW.org_id AND t.id = NEW.parent_task_id;
    IF NOT coalesce(v_found, false) THEN
      v_scope := crove_kernel.ctx_le_scope();
    END IF;
    IF NOT coalesce(v_found, false) AND v_scope IS NOT NULL AND NOT ('*' = ANY (v_scope)) THEN
      -- A parent a writer limited to some entities cannot read: possibly another entity's task.
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.task', 'parent', 'crove_kernel.task')::text;
    END IF;
  END IF;
  IF v_entity IS NULL AND pg_catalog.jsonb_typeof(NEW.source_ref) = 'object' THEN
    v_type := NEW.source_ref ->> 'type';
    v_id := pg_catalog.lower(NEW.source_ref ->> 'id');
    WHILE i + 2 < TG_NARGS LOOP
      IF TG_ARGV[i] = v_type THEN
        IF v_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          EXECUTE pg_catalog.format('SELECT s.%I FROM %s s WHERE s.org_id = $1 AND s.id = $2', TG_ARGV[i + 2], TG_ARGV[i + 1]::regclass)
            INTO v_entity USING NEW.org_id, v_id::uuid;
        END IF;
        IF v_entity IS NULL AND NEW.legal_entity_id IS NULL THEN
          -- A record the writer cannot read: the writer's own entity when it is limited to exactly one; refused for a
          -- writer limited to several (or none), which cannot tell which of them the record is about.
          v_scope := crove_kernel.ctx_le_scope();
          IF pg_catalog.cardinality(v_scope) = 1 AND v_scope[1] <> '*' THEN
            NEW.legal_entity_id := v_scope[1]::uuid;
          ELSIF v_scope IS NOT NULL AND NOT ('*' = ANY (v_scope)) THEN
            RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
              DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.task', 'record_type', v_type)::text;
          END IF;
        END IF;
        EXIT;
      END IF;
      i := i + 3;
    END LOOP;
  END IF;
  IF v_entity IS NOT NULL THEN
    IF NEW.legal_entity_id IS NULL THEN
      NEW.legal_entity_id := v_entity;
    ELSIF NEW.legal_entity_id <> v_entity THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.task')::text;
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.task_legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS task_legal_entity ON crove_kernel.task;

DO $$
DECLARE
  -- record type, table, column holding its entity (the trigger's arguments, in order)
  v_specs text[][] := ARRAY[
    ARRAY['finance.cash_voucher', 'crove_finance.cash_voucher', 'legal_entity_id'],
    ARRAY['finance.fixed_asset', 'crove_finance.fixed_asset', 'legal_entity_id'],
    ARRAY['finance.journal_entry', 'crove_finance.journal_entry', 'legal_entity_id'],
    ARRAY['finance.journal_voucher', 'crove_finance.journal_voucher', 'legal_entity_id'],
    ARRAY['finance.portal_invoice_list', 'crove_finance.portal_invoice_list', 'legal_entity_id'],
    ARRAY['finance.purchase_document', 'crove_finance.purchase_document', 'legal_entity_id'],
    ARRAY['kernel.legal_entity', 'crove_kernel.legal_entity', 'id'],
    ARRAY['kernel.proposal', 'crove_kernel.proposal', 'legal_entity_id']
  ];
  v_spec text[];
  v_args text := '';
  v_n bigint;
  v_pass int := 0;
BEGIN
  ALTER TABLE crove_kernel.task DISABLE TRIGGER task_before_update;
  -- 1. A task about a record of one entity takes the record's entity (ids compared as text: a malformed id matches
  --    nothing instead of failing a cast).
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_args := v_args || CASE WHEN v_args = '' THEN '' ELSE ', ' END
      || pg_catalog.format('%L, %L, %L', v_spec[1], v_spec[2], v_spec[3]);
    EXECUTE pg_catalog.format(
      'UPDATE crove_kernel.task t SET legal_entity_id = s.%I FROM %s s '
      'WHERE t.legal_entity_id IS NULL AND t.source_ref ->> ''type'' = %L '
      'AND s.org_id = t.org_id AND s.id::text = pg_catalog.lower(t.source_ref ->> ''id'')',
      v_spec[3], v_spec[2]::regclass, v_spec[1]);
  END LOOP;
  -- 2. A child takes its parent's entity when the parent has one, down the chain, as the trigger does: until nothing
  --    changes (one pass per level; the guard only bounds a malformed chain).
  LOOP
    UPDATE crove_kernel.task c SET legal_entity_id = p.legal_entity_id
    FROM crove_kernel.task p
    WHERE p.org_id = c.org_id AND p.id = c.parent_task_id
      AND p.legal_entity_id IS NOT NULL AND c.legal_entity_id IS DISTINCT FROM p.legal_entity_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_pass := v_pass + 1;
    EXIT WHEN v_n = 0 OR v_pass > 10;
  END LOOP;
  -- 3. The titles that copied a proposal's title before #1756.
  UPDATE crove_kernel.task SET title = 'Rà soát đề xuất chờ duyệt'
  WHERE kind = 'proposal_review' AND source_ref ->> 'type' = 'kernel.proposal' AND title LIKE 'Rà soát đề xuất: %';
  UPDATE crove_kernel.task SET title = 'Duyệt đề xuất đã rà soát'
  WHERE kind = 'escalation' AND source_ref ->> 'type' = 'kernel.proposal' AND title LIKE 'Duyệt đề xuất: %';
  ALTER TABLE crove_kernel.task ENABLE TRIGGER task_before_update;

  EXECUTE pg_catalog.format(
    'CREATE TRIGGER task_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_kernel.task '
    'FOR EACH ROW EXECUTE FUNCTION crove_kernel.task_legal_entity_fill(%s)', v_args);
END $$;
-- Also in replica mode, where ordinary triggers stay silent, so a row written there still gets its entity.
ALTER TABLE crove_kernel.task ENABLE ALWAYS TRIGGER task_legal_entity;

DROP POLICY IF EXISTS le_scope ON crove_kernel.task;
CREATE POLICY le_scope ON crove_kernel.task AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (legal_entity_id IS NULL OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
         OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK (legal_entity_id IS NULL OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
              OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- A comment is read and written only with its task, through the task's own policies.
DROP POLICY IF EXISTS task_scope ON crove_kernel.task_comment;
CREATE POLICY task_scope ON crove_kernel.task_comment AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_kernel.task t WHERE t.org_id = task_comment.org_id AND t.id = task_comment.task_id))
  WITH CHECK (EXISTS (SELECT 1 FROM crove_kernel.task t WHERE t.org_id = task_comment.org_id AND t.id = task_comment.task_id));

-- Fresh planner statistics after the backfill.
ANALYZE crove_kernel.task;
