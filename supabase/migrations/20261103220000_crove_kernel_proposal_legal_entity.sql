-- Crove kernel (issue #1538, plan §4.6 RLS "a RESTRICTIVE legal-entity-scope policy on every table with
-- legal_entity_id", kernel projections listed there; owner decision 2026-10-29, option (b)): agents' positions get a
-- real legal-entity scope, and proposals are scoped per legal entity. Idempotent; applied files stay untouched.
--
-- Before this file every position had le_scope '{}' (no command set it), so an agent's sealed context, which takes its
-- position's le_scope (enter_agent_context), named no legal entity: the finance books were hidden from every agent,
-- and proposal could not get the le_scope policy without hiding every proposal from every agent (agent triage and
-- approvals, T18). So a member limited to entity A still read entity B's proposals (lines, amounts, description)
-- through the Inbox (kernel.inbox.get) and the proposal timeline.
--
-- crove_kernel.position.le_scope   the legal entities the seat's holder works in, when an agent holds it:
--   - existing positions, all with '{}', are backfilled to '{*}' (every entity), the scope they would have needed to
--     keep reading every proposal (owner decision);
--   - a new position whose writer names no scope ('{}', the column default) gets the org's default entity as the
--     writer sees it (trigger position_le_scope, crove_kernel.position_le_scope_check); the org chart commands
--     (kernel.position.create and update, kernel.agent.template.install, owner only) let the owner name one. A writer
--     that cannot see the org's default entity (another org's row, no context) leaves '{}', and the tenant policy
--     refuses the row as before; '{}' still means no entity;
--   - a scope that names entities is '{*}' alone, or one or more distinct legal entities of the position's org, each
--     its id as text (the form ctx_le_scope compares), read as the writer; anything else is refused with
--     POSITION_SCOPE_INVALID (23514). The commands never write '{}'.
--   A member holding a position keeps the scope of its own assignments (enter_context); only agents read this one.
--
-- crove_kernel.proposal   legal_entity_id (filled since 20261103010000 by b_legal_entity: a proposal read from a file
--   takes its extraction's entity, any other the one its writer names, else the org's default entity, and never
--   changes) becomes NOT NULL and gets the RESTRICTIVE policy le_scope beside the tenant policy, the predicate of the
--   finance books (20261102140000) and the kernel projections (20261102230000): an actor reads and writes only the
--   proposals of the entities its sealed context's le_scope names ('*' every entity). So a member limited to some
--   entities sees only their proposals in the Inbox, and an agent only the proposals of its position's entities.
--   - Its stream hints carry the entity (#1692), so the API drops a hint for a stream whose scope leaves it out.
--   - Its activity rows (proposal.created, approved, rejected, ...) take its entity (#1716, trigger b_legal_entity on
--     crove_kernel.activity), so the proposal timeline is scoped too; existing rows are backfilled.
--   - Rows written before b_legal_entity existed were rewritten by 20261103010000. A NULL left since (a writer limited
--     to some entities naming an extraction it cannot see) takes its extraction's entity, else the org's default
--     entity, here; b_legal_entity is disabled around that UPDATE only (it refuses any change of the column).
--
-- Not in this file (the issue thread): the party policy on record_le links and party_link_for_tax_code's answer for a
-- person's party, and entity-scoped approval eligibility (P12 per entity).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- crove_kernel.position: the backfill, then the check
-- ---------------------------------------------------------------------------
UPDATE crove_kernel.position SET le_scope = ARRAY['*']::text[] WHERE le_scope = '{}'::text[];

-- BEFORE INSERT OR UPDATE OF le_scope. SECURITY INVOKER: the entities are read as the writer, so a writer names only
-- entities it can see (an owner, and the system context, see every entity of their org).
CREATE OR REPLACE FUNCTION crove_kernel.position_le_scope_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
  v_found int;
BEGIN
  IF NEW.le_scope IS NULL THEN
    RAISE EXCEPTION 'POSITION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.cardinality(NEW.le_scope) = 0 THEN
    IF TG_OP = 'INSERT' THEN
      SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
      IF v_entity IS NOT NULL THEN
        NEW.le_scope := ARRAY[v_entity::text];
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.array_position(NEW.le_scope, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'POSITION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF '*' = ANY (NEW.le_scope) THEN
    IF pg_catalog.cardinality(NEW.le_scope) <> 1 THEN
      RAISE EXCEPTION 'POSITION_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Every element one entity of the org, in the text form of its id, and no element twice.
  SELECT pg_catalog.count(*) INTO v_found
  FROM crove_kernel.legal_entity e
  WHERE e.org_id = NEW.org_id AND e.id::text = ANY (NEW.le_scope);
  IF v_found <> pg_catalog.cardinality(NEW.le_scope)
     OR (SELECT pg_catalog.count(DISTINCT s) FROM pg_catalog.unnest(NEW.le_scope) s) <> pg_catalog.cardinality(NEW.le_scope) THEN
    RAISE EXCEPTION 'POSITION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.position_le_scope_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS position_le_scope ON crove_kernel.position;
CREATE TRIGGER position_le_scope BEFORE INSERT OR UPDATE OF le_scope ON crove_kernel.position
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.position_le_scope_check();
-- Also in replica mode, where ordinary triggers stay silent, so a row written there is checked too.
ALTER TABLE crove_kernel.position ENABLE ALWAYS TRIGGER position_le_scope;

-- ---------------------------------------------------------------------------
-- crove_kernel.proposal: NOT NULL, the policy and the stream hint
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.proposal WHERE legal_entity_id IS NULL) THEN
    -- See the header. The UPDATE runs as the migration runner, the table's owner, which RLS does not filter.
    ALTER TABLE crove_kernel.proposal DISABLE TRIGGER b_legal_entity;
    UPDATE crove_kernel.proposal p
    SET legal_entity_id = coalesce(
      (SELECT x.legal_entity_id FROM crove_kernel.extraction x WHERE x.org_id = p.org_id AND x.id = p.extraction_id),
      crove_kernel.org_default_legal_entity(p.org_id))
    WHERE p.legal_entity_id IS NULL;
    ALTER TABLE crove_kernel.proposal ENABLE ALWAYS TRIGGER b_legal_entity;
  END IF;
END $$;
ALTER TABLE crove_kernel.proposal ALTER COLUMN legal_entity_id SET NOT NULL;

DROP POLICY IF EXISTS le_scope ON crove_kernel.proposal;
CREATE POLICY le_scope ON crove_kernel.proposal AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- The hint carries the proposal's entity (20261103080000): the API drops it for a stream whose scope leaves it out.
DROP TRIGGER IF EXISTS stream_hint ON crove_kernel.proposal;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('proposal', 'id', 'legal_entity_id');

-- ---------------------------------------------------------------------------
-- crove_kernel.activity: a proposal's rows take its entity. The trigger's list from 20261103120000, with
-- kernel.proposal added; the function is unchanged.
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
    ARRAY['kernel.proposal', 'crove_kernel.proposal', 'id', 'legal_entity_id']
  ];
  v_spec text[];
  v_args text := '';
BEGIN
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_args := v_args || CASE WHEN v_args = '' THEN '' ELSE ', ' END
      || pg_catalog.format('%L, %L, %L, %L', v_spec[1], v_spec[2], v_spec[3], v_spec[4]);
    -- The backfill, as in 20261103120000: rows still NULL take their record's entity (only kernel.proposal has any).
    EXECUTE pg_catalog.format(
      'UPDATE crove_kernel.activity a SET legal_entity_id = s.%I FROM %s s '
      'WHERE a.legal_entity_id IS NULL AND a.record_type = %L AND s.org_id = a.org_id AND s.%I = a.record_id',
      v_spec[4], v_spec[2]::regclass, v_spec[1], v_spec[3]);
  END LOOP;

  DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.activity;
  EXECUTE pg_catalog.format(
    'CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_kernel.activity '
    'FOR EACH ROW EXECUTE FUNCTION crove_kernel.activity_legal_entity_fill(%s)', v_args);
END $$;
-- Also in replica mode, where ordinary triggers stay silent, so a row written there still gets its entity.
ALTER TABLE crove_kernel.activity ENABLE ALWAYS TRIGGER b_legal_entity;

-- Fresh planner statistics for every table this file altered.
ANALYZE crove_kernel.position, crove_kernel.proposal, crove_kernel.activity;
