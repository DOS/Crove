-- Crove finance (issue #1280, plan §4.6 RLS and the finance tables, ADR-0021 section 7): the books are kept per legal
-- entity. Idempotent; applied files stay untouched.
--
-- Every finance table that holds books or documents gets legal_entity_id NOT NULL, a foreign key to the org's legal
-- entity, an index on (legal_entity_id, org_id) (G3 fk-index) and a RESTRICTIVE policy le_scope beside the tenant policy:
-- an actor reads and writes only the rows of the entities its sealed context's le_scope names ('*' every entity: owners,
-- admins and every member without legal-entity assignments; a member limited by external_accountant assignments only
-- those entities; no scope nothing). RESTRICTIVE, so it narrows tenant_isolation and never widens it. The scope is
-- fetched once per statement (an InitPlan), as on crove_kernel.legal_entity.
--
--   per legal entity       journal_entry, journal_line, period_balance_delta, cash_voucher, journal_voucher,
--                          purchase_document, purchase_line, purchase_tax_rate, purchase_document_void,
--                          input_vat_check, bank_line, fixed_asset, depreciation_line, portal_invoice_list,
--                          portal_invoice_row, categorization_rule, vat_return_filed
--   org-wide (unchanged)   account (the TT133 catalog, no org), org_account (the org's sub-accounts: one chart for
--                          every entity of the org), vendor_account_rule (keyed by party, which is org-wide; the party's
--                          record_le link narrows it later, #1280 part 3), period_lock (keyed per entity together with
--                          its guard and the lock functions, #1280 part 2)
--
-- Which entity a new row belongs to (trigger b_legal_entity, crove_finance.legal_entity_fill):
--   - a row with a parent takes the parent's entity: a journal line and a balance delta their entry's, a reversal the
--     reversed entry's, purchase lines, tax rates, voids and input VAT marks their document's, a replacement document
--     the document it replaces, a portal row its list's, a depreciation line its asset's, an asset and a learned rule
--     the purchase document they came from. A writer that names another entity is refused (LEGAL_ENTITY_MISMATCH).
--   - a row without one takes the entity the writer names, or, when it names none, the org's default entity. Every
--     writer on main names none today, so all books stay in the default entity until the posting path and the commands
--     take an entity (#1280 part 2); that is also why the existing writers need no change.
--   - legal_entity_id never changes once written (LEGAL_ENTITY_IMMUTABLE), and a parent key that changes later (a
--     learned rule's source document) must keep naming a parent of the same entity.
-- The trigger runs as the writer and reads the parent and the default entity through the writer's own policies: a row
-- whose parent the writer cannot see loses its entity and is refused (tenant policy, le_scope or NOT NULL), and a writer
-- limited to other entities who names none finds no default entity and is refused by le_scope, so nothing is ever
-- written into an entity, or under a parent, the writer cannot see. It is named to fire right after agent_write_guard
-- and before every other BEFORE trigger (they fire in name order), so later rules that read the entity (voucher
-- numbering and the period guard, part 2) see it filled in. It is enabled ALWAYS, so it fires in replica mode as well.
--
-- The backfill. Every row on main belongs to its org's default entity (no writer could name another one). The column
-- is added nullable, then filled with ALTER COLUMN ... TYPE uuid USING (...): PostgreSQL rewrites the table with the
-- expression's value in each row and fires no row trigger, so the append-only and immutability triggers of the ledger
-- (append_only_row on journal_entry, journal_line, period_balance_delta, the vouchers and voids) are neither fired nor
-- disabled, and no UPDATE runs. Nothing else in a row changes; the WORM row hashes (20261023230000, 20261026230000)
-- cover fixed column lists without the new column, so every archived batch still verifies. The rewrite holds an ACCESS
-- EXCLUSIVE lock on each table until the file commits; lock_timeout below bounds the wait for it, so a busy database
-- fails the migration (and the deploy stops on the old release) instead of queueing postings behind it. A table with no
-- NULL left (a second run, or a fresh database) is not rewritten.
--
-- crove_finance.period_balance_delta: its rows are summed per (org, legal entity, account, month), so that key gets an
-- index; one row per (org, entry, account) stays the unique key (an entry has one entity). The nightly comparison
-- (period_balance_differences) also reports a delta whose entity is not its entry's ('legal_entity').
--
-- crove_finance.categorization_rule: rules are learned per entity, so what a rule matches is unique per entity
-- (categorization_rule_match_uq gains legal_entity_id) and the vendor key gets its own index.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The org's default legal entity (exactly one per org, 20261030001000). SECURITY INVOKER and executable by no runtime
-- role: this file's backfill calls it as the migration runner, which owns crove_kernel.legal_entity and so reads it
-- unfiltered; later finance migrations may use it the same way.
CREATE OR REPLACE FUNCTION crove_finance.org_default_legal_entity(p_org_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = p_org_id AND e.is_default
$$;
REVOKE ALL ON FUNCTION crove_finance.org_default_legal_entity(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- BEFORE INSERT OR UPDATE OF legal_entity_id[, parent key]. Arguments: none for a table without a parent, or the parent
-- table and the column of this table that holds the parent's id (the parent's key is (org_id, id)). See the header.
-- SECURITY INVOKER: it reads the parent and the default entity as the writer, through the writer's own policies, so it
-- learns nothing the writer could not read. (A SECURITY DEFINER trigger here also made the period guard on journal_entry
-- re-plan its queries for every row: 20,000 entries in one statement took 82 s instead of 1.5 s.)
CREATE OR REPLACE FUNCTION crove_finance.legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row jsonb := pg_catalog.to_jsonb(NEW);
  v_given uuid := (v_row ->> 'legal_entity_id')::uuid;
  v_parent uuid;
  v_entity uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND v_given IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) ->> 'legal_entity_id')::uuid THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_IMMUTABLE' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME)::text;
  END IF;
  IF TG_NARGS = 2 THEN
    v_parent := (v_row ->> TG_ARGV[1])::uuid;
  END IF;
  IF v_parent IS NOT NULL THEN
    EXECUTE pg_catalog.format('SELECT p.legal_entity_id FROM %s p WHERE p.org_id = $1 AND p.id = $2', TG_ARGV[0]::regclass)
      INTO v_entity USING NEW.org_id, v_parent;
    IF v_entity IS NULL THEN
      -- A parent the writer cannot see (another org's, another entity's, or none at all). The row loses any entity it
      -- named, so the tenant policy, le_scope or NOT NULL refuses it: a writer never attaches a row to a parent it cannot
      -- see under an entity it can. In replica mode (superusers only), where foreign keys are not checked, the row
      -- takes the default entity like a row without a parent.
      IF pg_catalog.current_setting('session_replication_role') = 'replica' AND TG_OP = 'INSERT' AND v_given IS NULL THEN
        SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
        NEW.legal_entity_id := v_entity;
      ELSIF TG_OP = 'INSERT' THEN
        NEW.legal_entity_id := NULL;
      ELSE
        RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
          DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'parent', TG_ARGV[0])::text;
      END IF;
      RETURN NEW;
    END IF;
    IF v_given IS NULL THEN
      NEW.legal_entity_id := v_entity;
    ELSIF v_given <> v_entity THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'parent', TG_ARGV[0])::text;
    END IF;
    RETURN NEW;
  END IF;
  -- No parent: the entity the writer names, or the org's default entity as the writer sees it (none for another org's
  -- row or for a writer whose scope leaves the default entity out, which the policies then refuse).
  IF TG_OP = 'INSERT' AND v_given IS NULL THEN
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
    NEW.legal_entity_id := v_entity;
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The column, its backfill, key, index, trigger and policy, table by table (parents before their children)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_spec text[];
  v_table text;
  v_name text;
  v_parent text;
  v_parent_col text;
  v_null boolean;
  v_specs text[][] := ARRAY[
    -- table, parent table, parent key column ('' for none)
    ARRAY['crove_finance.journal_entry', 'crove_finance.journal_entry', 'reverses_entry_id'],
    ARRAY['crove_finance.journal_line', 'crove_finance.journal_entry', 'entry_id'],
    ARRAY['crove_finance.period_balance_delta', 'crove_finance.journal_entry', 'entry_id'],
    ARRAY['crove_finance.cash_voucher', '', ''],
    ARRAY['crove_finance.journal_voucher', '', ''],
    ARRAY['crove_finance.purchase_document', 'crove_finance.purchase_document', 'replaces_document_id'],
    ARRAY['crove_finance.purchase_line', 'crove_finance.purchase_document', 'document_id'],
    ARRAY['crove_finance.purchase_tax_rate', 'crove_finance.purchase_document', 'document_id'],
    ARRAY['crove_finance.purchase_document_void', 'crove_finance.purchase_document', 'document_id'],
    ARRAY['crove_finance.input_vat_check', 'crove_finance.purchase_document', 'document_id'],
    ARRAY['crove_finance.bank_line', '', ''],
    ARRAY['crove_finance.fixed_asset', 'crove_finance.purchase_document', 'source_document_id'],
    ARRAY['crove_finance.depreciation_line', 'crove_finance.fixed_asset', 'asset_id'],
    ARRAY['crove_finance.portal_invoice_list', '', ''],
    ARRAY['crove_finance.portal_invoice_row', 'crove_finance.portal_invoice_list', 'list_id'],
    ARRAY['crove_finance.categorization_rule', 'crove_finance.purchase_document', 'source_document_id'],
    ARRAY['crove_finance.vat_return_filed', '', '']
  ];
BEGIN
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_table := v_spec[1];
    v_name := pg_catalog.split_part(v_table, '.', 2);
    v_parent := v_spec[2];
    v_parent_col := v_spec[3];

    EXECUTE pg_catalog.format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS legal_entity_id uuid', v_table);
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s WHERE legal_entity_id IS NULL)', v_table) INTO v_null;
    IF v_null THEN
      -- A rewrite, not an UPDATE: no row trigger fires (see the header).
      EXECUTE pg_catalog.format(
        'ALTER TABLE %s ALTER COLUMN legal_entity_id TYPE uuid USING coalesce(legal_entity_id, crove_finance.org_default_legal_entity(org_id))',
        v_table);
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE %s ALTER COLUMN legal_entity_id SET NOT NULL', v_table);

    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   WHERE c.conrelid = v_table::regclass AND c.conname = v_name || '_legal_entity_fk') THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)',
        v_table, v_name || '_legal_entity_fk');
    END IF;
    -- The foreign key's index (G3 fk-index), entity first: led by org_id it would tempt the planner into scanning a whole
    -- org's rows for queries that filter by org and something else, before statistics exist (the period guard on
    -- journal_entry went quadratic on a bulk insert into a new table). period_balance_delta gets the wider balance key
    -- below, which backs its foreign key too.
    IF v_table <> 'crove_finance.period_balance_delta' THEN
      EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS %I ON %s (legal_entity_id, org_id)', v_name || '_legal_entity_idx', v_table);
    END IF;

    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS b_legal_entity ON %s', v_table);
    IF v_parent_col = '' THEN
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON %s '
        'FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill()', v_table);
    ELSE
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, %I ON %s '
        'FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill(%L, %L)', v_parent_col, v_table, v_parent, v_parent_col);
    END IF;
    -- Also in replica mode (session_replication_role = replica: logical replication, data copies), where ordinary
    -- triggers stay silent, so a row written there still gets its entity instead of failing NOT NULL.
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ALWAYS TRIGGER b_legal_entity', v_table);

    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS le_scope ON %s', v_table);
    EXECUTE pg_catalog.format(
      'CREATE POLICY le_scope ON %s AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
      'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))',
      v_table);
  END LOOP;
END $$;

-- Fresh planner statistics for every table this file altered: the ALTER TABLE steps above leave a table that was never
-- analyzed looking like one with unknown size (reltuples -1) instead of an empty one, and on a new database the period
-- guard on journal_entry then plans its per-row lookups as scans of the org's whole primary key, which made a bulk
-- insert of 20,000 entries take 45 s instead of 1 s. ANALYZE samples at most 30,000 rows per table.
ANALYZE crove_finance.journal_entry, crove_finance.journal_line, crove_finance.period_balance_delta, crove_finance.cash_voucher,
  crove_finance.journal_voucher, crove_finance.purchase_document, crove_finance.purchase_line, crove_finance.purchase_tax_rate,
  crove_finance.purchase_document_void, crove_finance.input_vat_check, crove_finance.bank_line, crove_finance.fixed_asset,
  crove_finance.depreciation_line, crove_finance.portal_invoice_list, crove_finance.portal_invoice_row,
  crove_finance.categorization_rule, crove_finance.vat_return_filed;

-- The balance key: a month's balance of an account in one entity is the sum of these rows.
CREATE INDEX IF NOT EXISTS period_balance_delta_balance_idx
  ON crove_finance.period_balance_delta (org_id, legal_entity_id, account_code, period_month);

-- Each entity files its own VAT returns: the latest mark of a period is read per entity (finance.vat.period's [22]).
CREATE INDEX IF NOT EXISTS vat_return_filed_entity_period_idx
  ON crove_finance.vat_return_filed (legal_entity_id, org_id, period, created_at DESC, id DESC);

-- What a rule matches is unique per entity. The vendor key loses the unique index that backed it, so it gets its own.
CREATE INDEX IF NOT EXISTS categorization_rule_vendor_idx ON crove_finance.categorization_rule (org_id, vendor_party_id)
  WHERE vendor_party_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'crove_finance.categorization_rule'::regclass AND c.conname = 'categorization_rule_match_uq'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%legal_entity_id%'
  ) THEN
    ALTER TABLE crove_finance.categorization_rule DROP CONSTRAINT IF EXISTS categorization_rule_match_uq;
    ALTER TABLE crove_finance.categorization_rule ADD CONSTRAINT categorization_rule_match_uq
      UNIQUE NULLS NOT DISTINCT (org_id, legal_entity_id, vendor_party_id, match_kind, match_text);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The nightly comparison, also checking each delta's entity against its entry's
-- ---------------------------------------------------------------------------
-- Same as 20261101160000, plus 'legal_entity' in mismatch when a delta and its entry name different entities (the
-- lines' entity is their entry's, by the trigger above). Same signature, owner and grants.
CREATE OR REPLACE FUNCTION crove_finance.period_balance_differences(p_limit int)
RETURNS TABLE (org_id uuid, account_code text, period_month date, entry_id uuid, mismatch text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH ledger AS (
    SELECT l.org_id, l.entry_id, l.account_code, pg_catalog.date_trunc('month', e.entry_date)::date AS period_month,
           e.legal_entity_id,
           pg_catalog.sum(l.debit) AS debit, pg_catalog.sum(l.credit) AS credit, pg_catalog.count(*) AS line_count
    FROM crove_finance.journal_line l
    JOIN crove_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
    GROUP BY 1, 2, 3, 4, 5
  ), compared AS (
    SELECT coalesce(g.org_id, d.org_id) AS org_id, coalesce(g.account_code, d.account_code) AS account_code,
           coalesce(g.period_month, d.period_month) AS period_month, coalesce(g.entry_id, d.entry_id) AS entry_id,
           ARRAY(SELECT v.m FROM (VALUES
             (CASE WHEN d.org_id IS NULL THEN 'missing' END),
             (CASE WHEN g.org_id IS NULL THEN 'extra' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.debit <> d.debit THEN 'debit' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.credit <> d.credit THEN 'credit' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.line_count <> d.line_count THEN 'lines' END),
             (CASE WHEN g.org_id IS NOT NULL AND d.org_id IS NOT NULL AND g.legal_entity_id <> d.legal_entity_id THEN 'legal_entity' END)
           ) AS v (m) WHERE v.m IS NOT NULL) AS mismatch
    FROM ledger g
    FULL JOIN crove_finance.period_balance_delta d
      ON d.org_id = g.org_id AND d.entry_id = g.entry_id AND d.account_code = g.account_code AND d.period_month = g.period_month
  )
  SELECT c.org_id, c.account_code, c.period_month, c.entry_id, c.mismatch
  FROM compared c
  WHERE pg_catalog.cardinality(c.mismatch) > 0
  ORDER BY c.org_id, c.account_code COLLATE "C", c.period_month, c.entry_id
  LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION crove_finance.period_balance_differences(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.period_balance_differences(int) TO crove_worker;
