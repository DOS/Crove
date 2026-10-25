-- Crove finance (issue #1280, part 2a; plan §4.6, ADR-0021 sections 2, 3 and 7): voucher numbering, the period lock
-- and the posting path per legal entity. Idempotent; applied files stay untouched. Builds on part 1
-- (20261102140000_crove_finance_legal_entity_scope.sql), which gave every finance book row a legal_entity_id.
--
-- Several parents. crove_finance.legal_entity_fill (trigger b_legal_entity) now takes any number of (parent table,
-- parent key column) pairs: every parent a row names must be of the row's entity, and the first one found gives it.
-- Re-created with all their links: purchase_document (the document it replaces, the document it corrects),
-- cash_voucher (the bank line it settles), input_vat_check (its document, the voucher that paid it),
-- purchase_document_void (its document, the reversal entry), depreciation_line (its asset, its journal entry). The
-- other tables keep their one parent. A writer limited to some entities whose parent it cannot see still loses the
-- entity and is refused; for any other writer an unseen parent is left to its foreign key, as in part 1.
--
-- Keys per legal entity:
--   cash_voucher       numbered per (org, entity, type): PT 1, 2, 3 ... in each entity. Key cash_voucher_number_uq.
--   journal_voucher    numbered per (org, entity): NVK 1, 2, 3 ... Key journal_voucher_number_uq.
--   purchase_document  a sales invoice's series and number are unique per entity (each entity issues its own invoices):
--                      purchase_document_sale_invoice_uq. A purchase invoice stays unique per org (one buyer only).
--   bank_line          a statement line is deduplicated per (org, entity, bank account): bank_line_dedupe_uq.
--   period_lock        one row per (org, entity): each entity locks its own months. The guard on journal_entry reads
--                      the entry's entity's row, and the opening entry rule holds per entity (each entity has its own
--                      opening balances). lock_period and unlock_period take the entity (NULL: the org's default
--                      entity); the one-argument forms lock the default entity, as before.
-- The voucher entry checks (cash, journal and purchase or sales documents) also require the entry to be of the
-- voucher's entity.
--
-- crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int, uuid)
--   The posting path with the legal entity as its last parameter: the one named, else the reversed entry's, else the
--   org's default entity, as the caller sees it (LEGAL_ENTITY_NOT_ALLOWED, 42501, for one it cannot see or that is not
--   the org's). Rebuilt from the newest body (20261101160000), with three changes: the entry is inserted with the
--   entity; a replay must name the same entity as the stored entry, otherwise IDEMPOTENCY_CONFLICT; a new revision of
--   a source must stay in the entity of the previous one (SOURCE_LEGAL_ENTITY, 23514).
--   Deviation from ADR-0021 section 5, on purpose: the entity is compared as a column, not added to payload_sha256, so
--   the hashes of every entry posted before #1280 still match their replays. The compensating control is that
--   legal_entity_id never changes once written, for any role (trigger b_legal_entity, tested per role).
--   The 7-argument form posts in the default entity (or the reversed entry's) through it; the 6- and 5-argument forms
--   still call the 7-argument one, so every caller and grant is unchanged.
--
-- crove_finance.period_balance_differences also reports an entry one of whose lines names another entity than the
-- entry ('legal_entity').
SET LOCAL lock_timeout = '2s';

-- A runner that is not a superuser (hosted PostgreSQL) needs the definer role's privileges to create and replace the
-- posting functions it owns (as in 20261101160000); granted first.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The entity trigger, with several parents
-- ---------------------------------------------------------------------------
-- BEFORE INSERT OR UPDATE OF legal_entity_id and the parent key columns. Arguments: pairs of (parent table, column of
-- this table holding the parent's id); the parent's key is (org_id, id). SECURITY INVOKER, as in part 1.
CREATE OR REPLACE FUNCTION crove_finance.legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row jsonb := pg_catalog.to_jsonb(NEW);
  v_given uuid := (v_row ->> 'legal_entity_id')::uuid;
  v_scope text[];
  v_scoped boolean;
  v_parent uuid;
  v_found uuid;
  v_entity uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND v_given IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) ->> 'legal_entity_id')::uuid THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_IMMUTABLE' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME)::text;
  END IF;
  FOR i IN 0 .. (TG_NARGS / 2) - 1 LOOP
    v_parent := (v_row ->> TG_ARGV[2 * i + 1])::uuid;
    CONTINUE WHEN v_parent IS NULL;
    v_found := NULL;
    EXECUTE pg_catalog.format('SELECT p.legal_entity_id FROM %s p WHERE p.org_id = $1 AND p.id = $2', TG_ARGV[2 * i]::regclass)
      INTO v_found USING NEW.org_id, v_parent;
    IF v_found IS NULL THEN
      -- A parent the writer cannot see. A writer limited to some entities never attaches a row under it: the row loses
      -- its entity (insert) or is refused (update). For any other writer it is another org's or missing, and its
      -- foreign key decides.
      IF v_scoped IS NULL THEN
        v_scope := crove_kernel.ctx_le_scope();
        v_scoped := v_scope IS NOT NULL AND NOT ('*' = ANY (v_scope));
      END IF;
      IF NOT v_scoped AND TG_OP = 'INSERT' THEN
        CONTINUE;
      ELSIF TG_OP = 'INSERT' THEN
        NEW.legal_entity_id := NULL;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'parent', TG_ARGV[2 * i])::text;
    END IF;
    IF v_entity IS NULL THEN
      v_entity := v_found;
    ELSIF v_entity <> v_found THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'parent', TG_ARGV[2 * i])::text;
    END IF;
  END LOOP;
  IF v_entity IS NOT NULL THEN
    IF v_given IS NULL THEN
      NEW.legal_entity_id := v_entity;
    ELSIF v_given <> v_entity THEN
      RAISE EXCEPTION 'LEGAL_ENTITY_MISMATCH' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('table', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME)::text;
    END IF;
    RETURN NEW;
  END IF;
  -- No parent seen: the entity the writer names, or the org's default entity as the writer sees it.
  IF TG_OP = 'INSERT' AND v_given IS NULL THEN
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
    NEW.legal_entity_id := v_entity;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DO $$
DECLARE
  v_spec text[];
  v_cols text;
  v_args text;
  v_specs text[][] := ARRAY[
    -- table, then (parent table, parent key column) pairs, padded with ''
    ARRAY['crove_finance.purchase_document', 'crove_finance.purchase_document', 'replaces_document_id', 'crove_finance.purchase_document', 'corrects_document_id'],
    ARRAY['crove_finance.cash_voucher', 'crove_finance.bank_line', 'bank_line_id', '', ''],
    ARRAY['crove_finance.input_vat_check', 'crove_finance.purchase_document', 'document_id', 'crove_finance.cash_voucher', 'voucher_id'],
    ARRAY['crove_finance.purchase_document_void', 'crove_finance.purchase_document', 'document_id', 'crove_finance.journal_entry', 'reversal_entry_id'],
    ARRAY['crove_finance.depreciation_line', 'crove_finance.fixed_asset', 'asset_id', 'crove_finance.journal_entry', 'entry_id']
  ];
BEGIN
  FOREACH v_spec SLICE 1 IN ARRAY v_specs LOOP
    v_cols := pg_catalog.quote_ident(v_spec[3]);
    v_args := pg_catalog.quote_literal(v_spec[2]) || ', ' || pg_catalog.quote_literal(v_spec[3]);
    IF v_spec[5] <> '' THEN
      v_cols := v_cols || ', ' || pg_catalog.quote_ident(v_spec[5]);
      v_args := v_args || ', ' || pg_catalog.quote_literal(v_spec[4]) || ', ' || pg_catalog.quote_literal(v_spec[5]);
    END IF;
    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS b_legal_entity ON %s', v_spec[1]);
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, %s ON %s '
      'FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill(%s)', v_cols, v_spec[1], v_args);
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ALWAYS TRIGGER b_legal_entity', v_spec[1]);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Keys and numbering per legal entity
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.cash_voucher'::regclass
                   AND c.conname = 'cash_voucher_number_uq' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%legal_entity_id%') THEN
    ALTER TABLE crove_finance.cash_voucher DROP CONSTRAINT IF EXISTS cash_voucher_number_uq;
    ALTER TABLE crove_finance.cash_voucher ADD CONSTRAINT cash_voucher_number_uq UNIQUE (org_id, legal_entity_id, voucher_type, number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.journal_voucher'::regclass
                   AND c.conname = 'journal_voucher_number_uq' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%legal_entity_id%') THEN
    ALTER TABLE crove_finance.journal_voucher DROP CONSTRAINT IF EXISTS journal_voucher_number_uq;
    ALTER TABLE crove_finance.journal_voucher ADD CONSTRAINT journal_voucher_number_uq UNIQUE (org_id, legal_entity_id, number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes i WHERE i.schemaname = 'crove_finance' AND i.indexname = 'purchase_document_sale_invoice_uq'
                   AND i.indexdef LIKE '%legal_entity_id%') THEN
    DROP INDEX IF EXISTS crove_finance.purchase_document_sale_invoice_uq;
    CREATE UNIQUE INDEX purchase_document_sale_invoice_uq
      ON crove_finance.purchase_document (org_id, legal_entity_id, invoice_series, invoice_number)
      WHERE replaces_document_id IS NULL AND direction = 'sale';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes i WHERE i.schemaname = 'crove_finance' AND i.indexname = 'bank_line_dedupe_uq'
                   AND i.indexdef LIKE '%legal_entity_id%') THEN
    DROP INDEX IF EXISTS crove_finance.bank_line_dedupe_uq;
    CREATE UNIQUE INDEX bank_line_dedupe_uq ON crove_finance.bank_line (org_id, legal_entity_id, bank_account, dedupe_key)
      WHERE dedupe_key IS NOT NULL;
  END IF;
END $$;

-- The next number of the org, entity and type, under a lock for that series (same as 20261019270000 otherwise). The
-- entity is filled in by b_legal_entity, which fires before this trigger.
CREATE OR REPLACE FUNCTION crove_finance.cash_voucher_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
    'crove_finance.cash_voucher:' || NEW.org_id::text || ':' || NEW.legal_entity_id::text || ':' || NEW.voucher_type, 0));
  SELECT coalesce(pg_catalog.max(v.number), 0) + 1 INTO NEW.number
  FROM crove_finance.cash_voucher v
  WHERE v.org_id = NEW.org_id AND v.legal_entity_id = NEW.legal_entity_id AND v.voucher_type = NEW.voucher_type;
  RETURN NEW;
END $$;

-- The next journal voucher number of the org and entity (same as 20261023150000 otherwise).
CREATE OR REPLACE FUNCTION crove_finance.journal_voucher_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_finance.journal_voucher:' || NEW.org_id::text || ':' || NEW.legal_entity_id::text, 0));
  SELECT coalesce(pg_catalog.max(v.number), 0) + 1 INTO NEW.number
  FROM crove_finance.journal_voucher v
  WHERE v.org_id = NEW.org_id AND v.legal_entity_id = NEW.legal_entity_id;
  RETURN NEW;
END $$;

-- By commit, the voucher's or document's entry exists and is of its entity (same as before otherwise).
CREATE OR REPLACE FUNCTION crove_finance.check_cash_voucher_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entry uuid;
  v_net numeric;
BEGIN
  SELECT e.id INTO v_entry
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = NEW.id
    AND e.reverses_entry_id IS NULL AND e.entry_date = NEW.voucher_date AND e.legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash voucher % must be posted as a journal entry dated % in the same transaction', NEW.id, NEW.voucher_date
      USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(pg_catalog.sum(l.debit), 0) - coalesce(pg_catalog.sum(l.credit), 0) INTO v_net
  FROM crove_finance.journal_line l
  WHERE l.org_id = NEW.org_id AND l.entry_id = v_entry AND l.account_code = NEW.cash_account;
  IF v_net IS DISTINCT FROM (CASE WHEN NEW.voucher_type IN ('cash_receipt', 'bank_credit') THEN NEW.amount ELSE -NEW.amount END) THEN
    RAISE EXCEPTION 'journal entry % of cash voucher % does not move % by the voucher amount', v_entry, NEW.id, NEW.cash_account
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_finance.check_journal_voucher_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry e
    WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = NEW.id
      AND e.reverses_entry_id IS NULL AND e.entry_date = NEW.voucher_date AND e.legal_entity_id = NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'journal voucher % must be posted as a journal entry dated % in the same transaction', NEW.id, NEW.voucher_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_finance.check_purchase_document_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry e
    WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = NEW.id
      AND e.reverses_entry_id IS NULL AND e.legal_entity_id = NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'purchase document % must be posted as a journal entry in the same transaction', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- The period lock per legal entity
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.period_lock ADD COLUMN IF NOT EXISTS legal_entity_id uuid;
-- Every existing row is the org's books, kept in the default entity until now. period_lock is not append-only; the
-- migration runner owns it.
UPDATE crove_finance.period_lock p SET legal_entity_id = crove_finance.org_default_legal_entity(p.org_id) WHERE p.legal_entity_id IS NULL;
ALTER TABLE crove_finance.period_lock ALTER COLUMN legal_entity_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.period_lock'::regclass AND c.conname = 'period_lock_legal_entity_fk') THEN
    ALTER TABLE crove_finance.period_lock ADD CONSTRAINT period_lock_legal_entity_fk
      FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id);
  END IF;
  -- One row per entity; the key also backs the foreign key.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.period_lock'::regclass AND c.conname = 'period_lock_entity_uq') THEN
    ALTER TABLE crove_finance.period_lock ADD CONSTRAINT period_lock_entity_uq UNIQUE (org_id, legal_entity_id);
  END IF;
  ALTER TABLE crove_finance.period_lock DROP CONSTRAINT IF EXISTS period_lock_org_uq;
END $$;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.period_lock;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.period_lock
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.period_lock ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.period_lock;
CREATE POLICY le_scope ON crove_finance.period_lock AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- The guard, per entity: the entry's entity's lock row and its opening entry (same as 20261020210000 otherwise).
CREATE OR REPLACE FUNCTION crove_finance.journal_entry_period_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_through date;
  v_opening_entry boolean := NEW.source_type = 'finance.opening_balance';
  v_opening date;
  v_first date;
  v_in_force uuid;
BEGIN
  -- No entity: the legal entity trigger (b_legal_entity, fired first) gave none, so the row's own policy or NOT NULL
  -- refuses it; there is no period to guard.
  IF NEW.legal_entity_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- The entity's row, created (nothing locked) by whichever of a posting or a lock comes first, read FOR UPDATE by an
  -- opening entry and FOR SHARE by every other entry.
  FOR i IN 1..2 LOOP
    IF v_opening_entry THEN
      SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id FOR UPDATE;
    ELSE
      SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id FOR SHARE;
    END IF;
    EXIT WHEN FOUND;
    INSERT INTO crove_finance.period_lock (org_id, legal_entity_id) VALUES (NEW.org_id, NEW.legal_entity_id)
      ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  END LOOP;
  IF v_through IS NOT NULL AND NEW.entry_date <= v_through THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = '55000',
      DETAIL = pg_catalog.json_build_object('lockedThrough', v_through, 'entryDate', NEW.entry_date)::text;
  END IF;

  IF v_opening_entry THEN
    -- One opening entry in force per org.
    SELECT o.id INTO v_in_force
    FROM crove_finance.journal_entry o
    WHERE o.org_id = NEW.org_id AND o.legal_entity_id = NEW.legal_entity_id AND o.source_type = 'finance.opening_balance'
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)
    LIMIT 1;
    IF v_in_force IS NOT NULL THEN
      RAISE EXCEPTION 'OPENING_BALANCE_EXISTS' USING ERRCODE = '55000',
        DETAIL = pg_catalog.json_build_object('entryId', v_in_force)::text;
    END IF;
    -- The earliest other entry, an opening entry's reversal excepted (it goes with the opening entry it cancels).
    SELECT pg_catalog.min(e.entry_date) INTO v_first
    FROM crove_finance.journal_entry e
    LEFT JOIN crove_finance.journal_entry o ON o.org_id = e.org_id AND o.id = e.reverses_entry_id
    WHERE e.org_id = NEW.org_id AND e.legal_entity_id = NEW.legal_entity_id AND e.source_type <> 'finance.opening_balance'
      AND (o.id IS NULL OR o.source_type <> 'finance.opening_balance')
      AND e.entry_date <= NEW.entry_date;
    IF v_first IS NOT NULL THEN
      RAISE EXCEPTION 'OPENING_BALANCE_AFTER_ENTRIES' USING ERRCODE = '55000',
        DETAIL = pg_catalog.json_build_object('firstEntryDate', v_first, 'entryDate', NEW.entry_date)::text;
    END IF;
  ELSIF NEW.reverses_entry_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry o
    WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_entry_id AND o.source_type = 'finance.opening_balance'
      AND o.entry_date = NEW.entry_date
  ) THEN
    -- The opening entry in force: not reversed (there is at most one; the latest date if a writer made more).
    SELECT pg_catalog.max(o.entry_date) INTO v_opening
    FROM crove_finance.journal_entry o
    WHERE o.org_id = NEW.org_id AND o.legal_entity_id = NEW.legal_entity_id AND o.source_type = 'finance.opening_balance'
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id);
    IF v_opening IS NOT NULL AND NEW.entry_date <= v_opening THEN
      RAISE EXCEPTION 'BEFORE_OPENING_BALANCE' USING ERRCODE = '55000',
        DETAIL = pg_catalog.json_build_object('openingDate', v_opening, 'entryDate', NEW.entry_date)::text;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The entity a lock or unlock is for: p_legal_entity_id, or the org's default entity when NULL. Raises
-- LEGAL_ENTITY_NOT_ALLOWED (42501) for an entity that is not the org's or that the context's le_scope leaves out. Runs
-- as the owner of the two definers below, so it checks the scope itself.
CREATE OR REPLACE FUNCTION crove_finance.period_lock_entity(p_org_id uuid, p_legal_entity_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e
  WHERE e.org_id = p_org_id AND (CASE WHEN p_legal_entity_id IS NULL THEN e.is_default ELSE e.id = p_legal_entity_id END);
  IF v_entity IS NULL OR NOT crove_kernel.ctx_le_allowed(v_entity) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501',
      DETAIL = pg_catalog.json_build_object('legalEntityId', p_legal_entity_id)::text;
  END IF;
  RETURN v_entity;
END $$;
REVOKE ALL ON FUNCTION crove_finance.period_lock_entity(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Lock and unlock a month of one entity (same rules, refusals and row lock as 20261020070000 and 20261101060100).
CREATE OR REPLACE FUNCTION crove_finance.lock_period(p_month date, p_legal_entity_id uuid) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_end date;
  v_from date;
  v_through date;
  v_entity uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_finance.assert_period_lock_role(ARRAY['owner', 'admin']);
  v_entity := crove_finance.period_lock_entity(v_org, p_legal_entity_id);
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PERIOD_INVALID' USING ERRCODE = '22023';
  END IF;
  v_end := (p_month + pg_catalog.make_interval(months => 1) - pg_catalog.make_interval(days => 1))::date;
  INSERT INTO crove_finance.period_lock (org_id, legal_entity_id) VALUES (v_org, v_entity) ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  SELECT p.locked_from, p.locked_through INTO v_from, v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR UPDATE;
  IF v_through IS NOT NULL AND v_end <= v_through THEN
    RAISE EXCEPTION 'PERIOD_ALREADY_LOCKED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  IF v_through IS NOT NULL AND p_month <> v_through + 1 THEN
    RAISE EXCEPTION 'EARLIER_PERIOD_OPEN' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  IF p_month >= pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'PERIOD_NOT_ENDED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  UPDATE crove_finance.period_lock p
  SET locked_from = COALESCE(v_from, p_month), locked_through = v_end, updated_by = crove_kernel.ctx_user_id(), updated_at = pg_catalog.now()
  WHERE p.org_id = v_org AND p.legal_entity_id = v_entity;
  RETURN v_end;
END $$;

CREATE OR REPLACE FUNCTION crove_finance.unlock_period(p_month date, p_legal_entity_id uuid) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_end date;
  v_from date;
  v_through date;
  v_entity uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- An owner, or a user holding finance.period.unlock org-wide (ctx_has_permission answers false for any other actor).
  IF NOT crove_kernel.ctx_has_permission('finance.period.unlock') THEN
    PERFORM crove_finance.assert_period_lock_role(ARRAY['owner']);
  END IF;
  v_entity := crove_finance.period_lock_entity(v_org, p_legal_entity_id);
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PERIOD_INVALID' USING ERRCODE = '22023';
  END IF;
  v_end := (p_month + pg_catalog.make_interval(months => 1) - pg_catalog.make_interval(days => 1))::date;
  SELECT p.locked_from, p.locked_through INTO v_from, v_through FROM crove_finance.period_lock p WHERE p.org_id = v_org AND p.legal_entity_id = v_entity FOR UPDATE;
  IF v_through IS NULL OR v_end > v_through THEN
    RAISE EXCEPTION 'PERIOD_NOT_LOCKED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  IF v_end < v_through THEN
    RAISE EXCEPTION 'LATER_PERIOD_LOCKED' USING DETAIL = pg_catalog.json_build_object('lockedThrough', v_through)::text;
  END IF;
  UPDATE crove_finance.period_lock p
  SET locked_from = CASE WHEN p_month <= v_from THEN NULL ELSE v_from END,
      locked_through = CASE WHEN p_month <= v_from THEN NULL ELSE p_month - 1 END,
      updated_by = crove_kernel.ctx_user_id(),
      updated_at = pg_catalog.now()
  WHERE p.org_id = v_org AND p.legal_entity_id = v_entity;
  RETURN CASE WHEN p_month <= v_from THEN NULL ELSE p_month - 1 END;
END $$;

REVOKE ALL ON FUNCTION crove_finance.lock_period(date, uuid), crove_finance.unlock_period(date, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.lock_period(date, uuid), crove_finance.unlock_period(date, uuid) TO crove_tenant;

-- The one-argument forms lock and unlock the org's default entity, as before.
CREATE OR REPLACE FUNCTION crove_finance.lock_period(p_month date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN crove_finance.lock_period(p_month, NULL::uuid);
END $$;
CREATE OR REPLACE FUNCTION crove_finance.unlock_period(p_month date) RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN crove_finance.unlock_period(p_month, NULL::uuid);
END $$;

-- ---------------------------------------------------------------------------
-- The posting path with the legal entity
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_reverses_entry_id uuid,
  p_source_revision int,
  p_legal_entity_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_entry uuid;
  v_currency text;
  v_minor int;
  v_bad record;
  v_hash bytea;
  v_same record;
  v_latest record;
  v_entity uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'a journal entry needs at least 2 lines' USING ERRCODE = '23514';
  END IF;
  IF p_source_type IS NULL OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'a journal entry needs a source' USING ERRCODE = '23502';
  END IF;
  IF p_source_revision IS NULL OR p_source_revision < 1 THEN
    RAISE EXCEPTION 'SOURCE_REVISION_INVALID' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('revision', p_source_revision)::text;
  END IF;
  IF p_reverses_entry_id IS NOT NULL AND p_source_revision <> 1 THEN
    RAISE EXCEPTION 'REVERSAL_REVISION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', p_source_revision, 'entryId', p_reverses_entry_id)::text;
  END IF;
  -- The legal entity (#1280): the one named, else the reversed entry's, else the org's default entity, as this caller
  -- sees them (crove_definer_tenant is a member of crove_tenant, so the context's le_scope applies to it). One the
  -- caller cannot see, or that is not the org's, is refused; nothing says whether it exists.
  IF p_legal_entity_id IS NOT NULL THEN
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.id = p_legal_entity_id;
  ELSIF p_reverses_entry_id IS NOT NULL THEN
    SELECT r.legal_entity_id INTO v_entity FROM crove_finance.journal_entry r WHERE r.org_id = v_org AND r.id = p_reverses_entry_id;
  ELSE
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.is_default;
  END IF;
  IF v_entity IS NULL OR NOT crove_kernel.ctx_le_allowed(v_entity) THEN
    RAISE EXCEPTION 'LEGAL_ENTITY_NOT_ALLOWED' USING ERRCODE = '42501',
      DETAIL = pg_catalog.json_build_object('legalEntityId', p_legal_entity_id)::text;
  END IF;
  SELECT t.base_currency, c.minor_units INTO v_currency, v_minor
  FROM crove_kernel.tenant t
  LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency
  WHERE t.org_id = v_org;
  IF v_minor IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_CURRENCY' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('currency', v_currency)::text;
  END IF;
  -- NaN and infinity (a jsonb string such as "NaN" reads as numeric NaN) are no amount; NaN would also pass the
  -- comparison below, since PostgreSQL holds NaN equal to itself.
  SELECT l.line_no, l.account_code, l.debit, l.credit INTO v_bad
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric)
  WHERE l.debit IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
     OR l.credit IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  ORDER BY l.line_no
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_INVALID' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object('lineNo', v_bad.line_no, 'account', v_bad.account_code)::text;
  END IF;
  -- Compared after rounding, so trailing zeros pass and any further decimal, however small, is refused before the
  -- amount domain could round it away.
  SELECT l.line_no, l.account_code, l.debit, l.credit INTO v_bad
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric)
  WHERE l.debit <> pg_catalog.round(l.debit, v_minor) OR l.credit <> pg_catalog.round(l.credit, v_minor)
  ORDER BY l.line_no
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_SCALE' USING ERRCODE = '22023',
      DETAIL = pg_catalog.json_build_object(
        'lineNo', v_bad.line_no, 'account', v_bad.account_code, 'currency', v_currency, 'minorUnits', v_minor,
        'amount', CASE WHEN v_bad.debit <> pg_catalog.round(v_bad.debit, v_minor) THEN v_bad.debit ELSE v_bad.credit END::text)::text;
  END IF;

  -- One source at a time, until this transaction ends. Each statement below takes a new snapshot (READ COMMITTED), so
  -- after the wait it sees what the previous holder committed.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'crove_finance.journal_entry.source:' || v_org::text || ':' || p_source_type || ':' || p_source_id::text, 0));
  v_hash := crove_finance.journal_payload_sha256(p_entry_date, v_currency, p_reverses_entry_id, p_lines);

  SELECT e.id, e.entry_date, e.reverses_entry_id, e.payload_sha256, e.legal_entity_id INTO v_same
  FROM crove_finance.journal_entry e
  WHERE e.org_id = v_org AND e.source_type = p_source_type AND e.source_id = p_source_id AND e.source_revision = p_source_revision;
  IF FOUND THEN
    -- A replay is the same payload for the same legal entity. The entity is compared as a column, not inside the
    -- payload hash, so the hashes of entries posted before #1280 still match; legal_entity_id never changes once
    -- written (trigger b_legal_entity), so the stored entity is the one it was posted for.
    IF v_same.legal_entity_id = v_entity AND coalesce(v_same.payload_sha256, crove_finance.journal_payload_sha256(v_same.entry_date, v_currency, v_same.reverses_entry_id, (
         SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'line_no', l.line_no, 'account_code', l.account_code, 'debit', l.debit, 'credit', l.credit, 'party_id', l.party_id))
         FROM crove_finance.journal_line l WHERE l.org_id = v_org AND l.entry_id = v_same.id))) = v_hash THEN
      RETURN v_same.id;
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505', CONSTRAINT = 'journal_entry_source_revision_key',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', p_source_revision, 'entryId', v_same.id)::text;
  END IF;

  SELECT e.id, e.source_revision, e.legal_entity_id INTO v_latest
  FROM crove_finance.journal_entry e
  WHERE e.org_id = v_org AND e.source_type = p_source_type AND e.source_id = p_source_id
  ORDER BY e.source_revision DESC
  LIMIT 1;
  IF p_source_revision <> coalesce(v_latest.source_revision, 0) + 1 THEN
    RAISE EXCEPTION 'REVISION_OUT_OF_ORDER' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'expected', coalesce(v_latest.source_revision, 0) + 1,
        'revision', p_source_revision)::text;
  END IF;
  -- Every revision of a source is in one legal entity: a document does not move between entities.
  IF v_latest.id IS NOT NULL AND v_latest.legal_entity_id <> v_entity THEN
    RAISE EXCEPTION 'SOURCE_LEGAL_ENTITY' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', v_latest.source_revision, 'entryId', v_latest.id)::text;
  END IF;
  IF v_latest.id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = v_org AND r.reverses_entry_id = v_latest.id) THEN
    RAISE EXCEPTION 'SOURCE_STILL_POSTED' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object(
        'sourceType', p_source_type, 'sourceId', p_source_id, 'revision', v_latest.source_revision, 'entryId', v_latest.id)::text;
  END IF;

  INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, created_by, reverses_entry_id,
                                           source_revision, payload_sha256, legal_entity_id)
  VALUES (v_org, p_entry_date, p_description, p_source_type, p_source_id, crove_kernel.ctx_user_id(), p_reverses_entry_id,
          p_source_revision, v_hash, v_entity)
  RETURNING id INTO v_entry;
  INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo)
  SELECT v_org, v_entry, l.line_no, l.account_code, coalesce(l.debit, 0), coalesce(l.credit, 0), l.party_id, l.memo
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (line_no int, account_code text, debit numeric, credit numeric, party_id uuid, memo text);
  PERFORM crove_finance.assert_entry_balanced(v_org, v_entry);

  -- The entry's deltas, summed from the request, which is exactly what the insert above stored (the lines are not read
  -- back: a line hidden from this role by a policy would otherwise be missed). Appended rows lock nothing another
  -- posting needs.
  INSERT INTO crove_finance.period_balance_delta (org_id, entry_id, account_code, period_month, debit, credit, line_count)
  SELECT v_org, v_entry, l.account_code, pg_catalog.date_trunc('month', p_entry_date)::date,
         pg_catalog.sum(coalesce(l.debit, 0)), pg_catalog.sum(coalesce(l.credit, 0)), pg_catalog.count(*)
  FROM pg_catalog.jsonb_to_recordset(p_lines) AS l (account_code text, debit numeric, credit numeric)
  GROUP BY l.account_code;
  RETURN v_entry;
END $$;

REVOKE ALL ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int, uuid) TO crove_tenant;

-- The 7-argument form posts through it: in the reversed entry's entity for a reversal, otherwise the default entity.
-- CREATE OR REPLACE keeps its owner (crove_definer_tenant) and grants.
CREATE OR REPLACE FUNCTION crove_finance.post_journal_entry(
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_lines jsonb,
  p_reverses_entry_id uuid,
  p_source_revision int
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN crove_finance.post_journal_entry(p_entry_date, p_description, p_source_type, p_source_id, p_lines, p_reverses_entry_id,
                                          p_source_revision, NULL::uuid);
END $$;

GRANT CREATE ON SCHEMA crove_finance TO crove_definer_tenant;
ALTER FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int, uuid) OWNER TO crove_definer_tenant;
ALTER FUNCTION crove_finance.post_journal_entry(date, text, text, uuid, jsonb, uuid, int) OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_finance FROM crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The nightly comparison, also checking each line's entity
-- ---------------------------------------------------------------------------
-- Same as 20261102140000, plus 'legal_entity' when one of the entry's lines on the account names another entity than
-- the entry. Same signature, owner and grants.
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
           pg_catalog.bool_or(l.legal_entity_id <> e.legal_entity_id) AS line_entity_differs,
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
             (CASE WHEN g.org_id IS NOT NULL AND (g.line_entity_differs OR (d.org_id IS NOT NULL AND g.legal_entity_id <> d.legal_entity_id))
                   THEN 'legal_entity' END)
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

ANALYZE crove_finance.period_lock, crove_finance.cash_voucher, crove_finance.journal_voucher, crove_finance.purchase_document,
  crove_finance.bank_line;
