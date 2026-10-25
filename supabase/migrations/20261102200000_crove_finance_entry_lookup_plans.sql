-- Crove finance (issue #1525, after #1280): the lookups the posting triggers run on every journal entry and voucher
-- stay on narrow indexes, whatever the planner believes about the table's size. Idempotent; applied files stay
-- untouched.
--
-- Since 20261102150000 two trigger lookups also filter on legal_entity_id:
--   - the period guard (journal_entry_period_open) looks for the entity's opening entry on every entry;
--   - the voucher and document entry checks (check_cash_voucher_entry, check_journal_voucher_entry,
--     check_purchase_document_entry) look for the voucher's entry at commit.
-- When a large batch is written in one transaction the table's statistics still describe it as small, and the plans
-- cached for these triggers then read every entry of the org: the guard by a sequential scan, the checks through
-- journal_entry_legal_entity_idx (legal_entity_id, org_id) with the source as a filter. Each insert then costs as much
-- as the entries before it, so a bulk load grows with the square of its size (a 50,000 document seed went past five
-- minutes).
--
-- The fix:
--   - journal_entry_opening_idx, a partial index on the opening entries alone (a handful per org), read by the guard
--     through crove_finance.live_opening_entry_date, which plans its query on each call;
--   - the three checks find the entry by its source key (journal_entry_source_revision_key: org, source type, source)
--     and compare its legal entity afterwards, so no plan can prefer the entity index. Same refusals as before.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS journal_entry_opening_idx ON crove_finance.journal_entry (org_id, legal_entity_id, entry_date)
  WHERE source_type = 'finance.opening_balance';

-- By commit, the voucher's entry exists, is of its entity and moves the cash account by the voucher amount (same as
-- 20261102150000 otherwise).
CREATE OR REPLACE FUNCTION crove_finance.check_cash_voucher_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entry uuid;
  v_entity uuid;
  v_net numeric;
BEGIN
  SELECT e.id, e.legal_entity_id INTO v_entry, v_entity
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = NEW.id
    AND e.reverses_entry_id IS NULL AND e.entry_date = NEW.voucher_date;
  IF NOT FOUND OR v_entity IS DISTINCT FROM NEW.legal_entity_id THEN
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
DECLARE
  v_entity uuid;
BEGIN
  SELECT e.legal_entity_id INTO v_entity
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = NEW.id
    AND e.reverses_entry_id IS NULL AND e.entry_date = NEW.voucher_date;
  IF NOT FOUND OR v_entity IS DISTINCT FROM NEW.legal_entity_id THEN
    RAISE EXCEPTION 'journal voucher % must be posted as a journal entry dated % in the same transaction', NEW.id, NEW.voucher_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- A document's first entry and every revision share its source and its entity (SOURCE_LEGAL_ENTITY), so any entry of
-- the document that is not a reversal answers for the entity.
CREATE OR REPLACE FUNCTION crove_finance.check_purchase_document_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (
      SELECT e.legal_entity_id
      FROM crove_finance.journal_entry e
      WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = NEW.id
        AND e.reverses_entry_id IS NULL
      OFFSET 0
    ) s
    WHERE s.legal_entity_id = NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'purchase document % must be posted as a journal entry in the same transaction', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- The date of the opening entry in force of an org's legal entity: not reversed (there is at most one; the latest date
-- if a writer made more). The query is run with EXECUTE, so it is planned on each call with the table's current size
-- and reads journal_entry_opening_idx once the table is large. A cached plan (the guard's own, or a SQL function's,
-- which lives as long as the statement calling it) keeps what it chose for the first entry of a batch: a sequential
-- scan, which every later entry of the batch then repeats over a larger table (#1525).
CREATE OR REPLACE FUNCTION crove_finance.live_opening_entry_date(p_org_id uuid, p_legal_entity_id uuid) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_date date;
BEGIN
  EXECUTE 'SELECT pg_catalog.max(o.entry_date) FROM crove_finance.journal_entry o '
          'WHERE o.org_id = $1 AND o.legal_entity_id = $2 AND o.source_type = ''finance.opening_balance'' '
          'AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)'
    INTO v_date USING p_org_id, p_legal_entity_id;
  RETURN v_date;
END $$;
REVOKE ALL ON FUNCTION crove_finance.live_opening_entry_date(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The period guard, reading the opening entry through it (same as 20261102150000 otherwise).
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
    -- One opening entry in force per org and legal entity.
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
    v_opening := crove_finance.live_opening_entry_date(NEW.org_id, NEW.legal_entity_id);
    IF v_opening IS NOT NULL AND NEW.entry_date <= v_opening THEN
      RAISE EXCEPTION 'BEFORE_OPENING_BALANCE' USING ERRCODE = '55000',
        DETAIL = pg_catalog.json_build_object('openingDate', v_opening, 'entryDate', NEW.entry_date)::text;
    END IF;
  END IF;
  RETURN NEW;
END $$;


ANALYZE crove_finance.journal_entry;
