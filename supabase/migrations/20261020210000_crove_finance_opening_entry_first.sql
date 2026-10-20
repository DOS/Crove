-- Crove finance (issue #366 item 1, review of #320): the opening entry stays first. Opening balances are as at the end
-- of their date, so every other entry of the org must be dated later. finance.opening_balance.post checks that at
-- import time, under a lock that serializes opening imports only: a purchase, a sale, a reversal or a voucher dated on
-- or before the opening date could still be posted afterwards, or commit while the import ran, and the opening entry
-- would no longer be first. The rule now lives in the posting guard on journal_entry (20261020070000), so it holds for
-- every writer that runs with triggers enabled, whatever the path:
-- - An entry dated on or before the org's opening entry in force (source 'finance.opening_balance', not reversed) is
--   refused: BEFORE_OPENING_BALANCE (55000) with the opening and entry dates as JSON detail. The opening entry's own
--   reversal is exempt: it is dated on the opening date (reversal.ts), so the two cancel out at every date.
-- - An opening entry is refused while another opening entry is in force (OPENING_BALANCE_EXISTS, 55000, its id as JSON
--   detail: reverse it first), and while another entry (not an opening entry, nor the reversal of one) is dated on or
--   before it: OPENING_BALANCE_AFTER_ENTRIES (55000) with the first such date as JSON detail.
-- Concurrency: the guard already reads the org's period_lock row FOR SHARE for every posting. An opening entry takes it
-- FOR UPDATE instead, so an opening import waits for postings in flight and a posting waits for an opening import in
-- flight; whichever comes second reads the other's committed entry (each statement of the guard takes a new snapshot
-- under READ COMMITTED, the runtime's isolation for commands) and is refused if it breaks the rule. The lock and unlock
-- functions take the same row FOR UPDATE, as before.
-- Entries posted before this migration are not checked again. Idempotent.
SET LOCAL lock_timeout = '2s';

-- The guard, replaced: the period lock as in 20261020070000, then the opening entry rule. Owned by the table owner
-- (SECURITY DEFINER), so it sees every entry of the org whatever the writer can see, and the row it creates.
CREATE OR REPLACE FUNCTION crove_finance.journal_entry_period_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_through date;
  v_opening_entry boolean := NEW.source_type = 'finance.opening_balance';
  v_opening date;
  v_first date;
  v_in_force uuid;
BEGIN
  -- The org's row, created (nothing locked) by whichever of a posting or a lock comes first, read FOR UPDATE by an
  -- opening entry and FOR SHARE by every other entry.
  FOR i IN 1..2 LOOP
    IF v_opening_entry THEN
      SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = NEW.org_id FOR UPDATE;
    ELSE
      SELECT p.locked_through INTO v_through FROM crove_finance.period_lock p WHERE p.org_id = NEW.org_id FOR SHARE;
    END IF;
    EXIT WHEN FOUND;
    INSERT INTO crove_finance.period_lock (org_id) VALUES (NEW.org_id) ON CONFLICT (org_id) DO NOTHING;
  END LOOP;
  IF v_through IS NOT NULL AND NEW.entry_date <= v_through THEN
    RAISE EXCEPTION 'PERIOD_LOCKED' USING ERRCODE = '55000',
      DETAIL = pg_catalog.json_build_object('lockedThrough', v_through, 'entryDate', NEW.entry_date)::text;
  END IF;

  IF v_opening_entry THEN
    -- One opening entry in force per org.
    SELECT o.id INTO v_in_force
    FROM crove_finance.journal_entry o
    WHERE o.org_id = NEW.org_id AND o.source_type = 'finance.opening_balance'
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
    WHERE e.org_id = NEW.org_id AND e.source_type <> 'finance.opening_balance'
      AND (o.id IS NULL OR o.source_type <> 'finance.opening_balance')
      AND e.entry_date <= NEW.entry_date;
    IF v_first IS NOT NULL THEN
      RAISE EXCEPTION 'OPENING_BALANCE_AFTER_ENTRIES' USING ERRCODE = '55000',
        DETAIL = pg_catalog.json_build_object('firstEntryDate', v_first, 'entryDate', NEW.entry_date)::text;
    END IF;
  ELSIF NEW.reverses_entry_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry o
    WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_entry_id AND o.source_type = 'finance.opening_balance'
  ) THEN
    -- The opening entry in force: not reversed (there is at most one; the latest date if a writer made more).
    SELECT pg_catalog.max(o.entry_date) INTO v_opening
    FROM crove_finance.journal_entry o
    WHERE o.org_id = NEW.org_id AND o.source_type = 'finance.opening_balance'
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id);
    IF v_opening IS NOT NULL AND NEW.entry_date <= v_opening THEN
      RAISE EXCEPTION 'BEFORE_OPENING_BALANCE' USING ERRCODE = '55000',
        DETAIL = pg_catalog.json_build_object('openingDate', v_opening, 'entryDate', NEW.entry_date)::text;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A trigger function only; nobody calls it directly (as in 20261020070000).
REVOKE ALL ON FUNCTION crove_finance.journal_entry_period_open() FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261018150000): the guard must run as a role that row security does not filter on the tables it
-- reads, or it would miss an opening entry or an earlier entry the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.journal_entry_period_open()'::pg_catalog.regprocedure
    AND c.oid IN ('crove_finance.journal_entry'::pg_catalog.regclass, 'crove_finance.period_lock'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.journal_entry_period_open() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;
