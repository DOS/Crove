-- Crove kernel (issue #1716, plan §4.6 RLS "a RESTRICTIVE legal-entity-scope policy on every table with
-- legal_entity_id", kernel projections listed there, and Phase 1 exit criterion 2 "cross-legal-entity, kernel tables
-- included"): the activity timeline is scoped per legal entity for the records that belong to one. Idempotent; applied
-- files stay untouched.
--
-- Before this file a member limited to entity A read entity B's activity rows (voucher codes, amounts and
-- descriptions) through the proposal timeline (kernel.proposal.timeline) and the org overview.
--
-- crove_kernel.activity gets a nullable legal_entity_id, a foreign key to the org's legal entity, an index on
-- (legal_entity_id, org_id) (G3 fk-index) and the RESTRICTIVE policy le_scope beside the tenant policy. NULL is an
-- org-level row (a party, a member, the org's settings, a proposal, a file): every member of the org keeps reading it.
-- A row with an entity is read and written only by an actor whose sealed context's le_scope names that entity ('*'
-- every entity), the predicate role_assignment_scope uses (20261101060000).
--
-- Which rows get an entity (trigger b_legal_entity, crove_kernel.activity_legal_entity_fill, BEFORE INSERT, ENABLE
-- ALWAYS): the trigger's arguments list, in triples, a record type, the table that holds such records and the column
-- that holds the record id. An activity row of a listed type takes the legal_entity_id of its record, read as the
-- writer (SECURITY INVOKER, through the writer's own policies). The writer (Runtime ctx.activity in
-- packages/kernel-runtime) names none, so it stays untouched. The listed types, every one whose table carries a NOT NULL
-- legal_entity_id since #1280:
--   finance.cash_voucher, finance.journal_voucher, finance.fixed_asset, finance.journal_entry,
--   finance.purchase_document (purchases and sales), finance.portal_invoice_list by their id;
--   finance.bank_account, whose record id is a statement import (bank.ts), by crove_finance.bank_line.import_id.
-- number.voided (numbering.ts) names the voucher it voided, so it is covered by the voucher types.
-- When the writer cannot read the record (gone, or not in its scope), the row takes the writer's own entity when its
-- scope is exactly one entity, and stays org-level otherwise: a statement import with no new line stores no bank_line,
-- and its row (an account code and line counts) is org-level for writers with every entity in scope.
-- A writer that names an entity keeps it when its record type is not listed (le_scope's WITH CHECK and the foreign key
-- still apply); for a listed type a different entity than the record's is refused (LEGAL_ENTITY_MISMATCH).
--
-- Not listed, so org-level:
--   kernel.proposal   proposal.legal_entity_id is a stamp, not a scope, until the owner decides #1538: agents' positions
--                     have an empty le_scope, so an entity on an agent's proposal.created or proposal.approved row
--                     would be refused by le_scope's WITH CHECK and break agent triage and approvals (T18). The
--                     proposal row itself is still read org-wide, so its timeline rows reveal nothing more.
--   kernel.file       a file has no entity (its readings, crove_kernel.extraction, do).
--   finance.period, finance.archive   their record id is the org's id, so no record names the entity; their summaries
--                     name a month or a year only.
-- Agents read no activity row (no agent query or tool reads the table): their empty scope (#1538) only means they write
-- org-level rows, which le_scope accepts.
--
-- The backfill. Existing rows of the listed types take their record's entity with an UPDATE as the migration runner
-- (the table's owner, which RLS does not filter), joined on the record's key: deterministic, it touches only rows still
-- NULL, so a rerun changes nothing. activity has no UPDATE trigger that matters here (agent_write_guard exempts it,
-- 20261019010000; the others are BEFORE INSERT), and no tenant role may update it (append-only grants). Rows whose
-- record is gone stay org-level. lock_timeout bounds the wait for the table's lock; activity is not a hot table in
-- the plan's list (§5.5).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.activity ADD COLUMN IF NOT EXISTS legal_entity_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                 WHERE c.conrelid = 'crove_kernel.activity'::regclass AND c.conname = 'activity_legal_entity_fk') THEN
    ALTER TABLE crove_kernel.activity ADD CONSTRAINT activity_legal_entity_fk
      FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id);
  END IF;
END $$;
-- The foreign key's index (G3 fk-index), entity first, as in 20261102140000.
CREATE INDEX IF NOT EXISTS activity_legal_entity_idx ON crove_kernel.activity (legal_entity_id, org_id);

-- BEFORE INSERT. Arguments: triples of (record type, table, column holding the record id); see the header.
-- SECURITY INVOKER: it reads the record as the writer, so it learns nothing the writer could not read.
CREATE OR REPLACE FUNCTION crove_kernel.activity_legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
  v_scope text[];
  i int := 0;
BEGIN
  WHILE i + 2 < TG_NARGS LOOP
    IF TG_ARGV[i] = NEW.record_type THEN
      EXECUTE pg_catalog.format('SELECT s.legal_entity_id FROM %s s WHERE s.org_id = $1 AND s.%I = $2 LIMIT 1',
                                TG_ARGV[i + 1]::regclass, TG_ARGV[i + 2])
        INTO v_entity USING NEW.org_id, NEW.record_id;
      IF v_entity IS NOT NULL THEN
        IF NEW.legal_entity_id IS NULL THEN
          NEW.legal_entity_id := v_entity;
        ELSIF NEW.legal_entity_id <> v_entity THEN
          RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
            DETAIL = pg_catalog.json_build_object('table', 'crove_kernel.activity', 'record_type', NEW.record_type)::text;
        END IF;
      ELSIF NEW.legal_entity_id IS NULL THEN
        -- A record the writer cannot read: the writer's own entity when it is limited to exactly one.
        v_scope := crove_kernel.ctx_le_scope();
        IF pg_catalog.cardinality(v_scope) = 1 AND v_scope[1] <> '*' THEN
          NEW.legal_entity_id := v_scope[1]::uuid;
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    i := i + 3;
  END LOOP;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.activity_legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DO $$
DECLARE
  -- record type, table, column holding the record id (the trigger's arguments, in this order)
  v_specs text[][] := ARRAY[
    ARRAY['finance.bank_account', 'crove_finance.bank_line', 'import_id'],
    ARRAY['finance.cash_voucher', 'crove_finance.cash_voucher', 'id'],
    ARRAY['finance.fixed_asset', 'crove_finance.fixed_asset', 'id'],
    ARRAY['finance.journal_entry', 'crove_finance.journal_entry', 'id'],
    ARRAY['finance.journal_voucher', 'crove_finance.journal_voucher', 'id'],
    ARRAY['finance.portal_invoice_list', 'crove_finance.portal_invoice_list', 'id'],
    ARRAY['finance.purchase_document', 'crove_finance.purchase_document', 'id']
  ];
  v_spec text[];
  v_args text := '';
BEGIN
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_args := v_args || CASE WHEN v_args = '' THEN '' ELSE ', ' END
      || pg_catalog.format('%L, %L, %L', v_spec[1], v_spec[2], v_spec[3]);
    -- The backfill (see the header): rows still NULL take their record's entity.
    EXECUTE pg_catalog.format(
      'UPDATE crove_kernel.activity a SET legal_entity_id = s.legal_entity_id FROM %s s '
      'WHERE a.legal_entity_id IS NULL AND a.record_type = %L AND s.org_id = a.org_id AND s.%I = a.record_id',
      v_spec[2]::regclass, v_spec[1], v_spec[3]);
  END LOOP;

  DROP TRIGGER IF EXISTS b_legal_entity ON crove_kernel.activity;
  EXECUTE pg_catalog.format(
    'CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_kernel.activity '
    'FOR EACH ROW EXECUTE FUNCTION crove_kernel.activity_legal_entity_fill(%s)', v_args);
END $$;
-- Also in replica mode, where ordinary triggers stay silent, so a row written there still gets its entity.
ALTER TABLE crove_kernel.activity ENABLE ALWAYS TRIGGER b_legal_entity;

DROP POLICY IF EXISTS le_scope ON crove_kernel.activity;
CREATE POLICY le_scope ON crove_kernel.activity AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (legal_entity_id IS NULL OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
         OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK (legal_entity_id IS NULL OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
              OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- Fresh planner statistics after the backfill.
ANALYZE crove_kernel.activity;
