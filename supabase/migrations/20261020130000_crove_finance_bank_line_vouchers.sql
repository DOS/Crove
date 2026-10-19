-- Crove finance (issue #326, stage 2a): a bank voucher records the bank statement line it settles. Idempotent; applied
-- files stay untouched.
--
-- cash_voucher.bank_line_id names the statement line (crove_finance.bank_line, 20261020080000) that a báo Có or báo
-- Nợ settles, when the voucher was made from one. The line itself stays append-only; the link lives on the voucher,
-- which is append-only too. The database holds the link for every writer:
-- - only a bank voucher names a line (CHECK), and the line is one of the org's (foreign key on (org_id, bank_line_id));
-- - the line is in the voucher's bank account, moves money the voucher's way (into the account for a báo Có, out of
--   it for a báo Nợ), by the voucher's amount, on the voucher's date;
-- - a line is settled by at most one voucher whose journal entry is not reversed. A voucher is corrected by reversing
--   its entry, and its line can then be matched again, so no unique index can hold this. The check runs under a
--   transaction-level advisory lock per line: of two postings for one line, the second waits for the first to commit
--   and then sees it (READ COMMITTED, the runtime's isolation for commands: each statement of the trigger reads a new
--   snapshot). It is an AFTER INSERT trigger, for two reasons: it runs after the row passed row security (a BEFORE
--   trigger runs before the WITH CHECK policy, so a security definer one would read another org's line for a row the
--   policy then refuses), and after cash_voucher_number, so a posting takes its numbering lock first and its line's lock
--   second: bulk approvals order vouchers by type to keep the numbering locks in one order
--   (packages/kernel/src/commands.ts), and every line lock is taken under them.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.cash_voucher ADD COLUMN IF NOT EXISTS bank_line_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'cash_voucher_bank_line_fk'
                   AND conrelid = 'crove_finance.cash_voucher'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.cash_voucher
      ADD CONSTRAINT cash_voucher_bank_line_fk FOREIGN KEY (org_id, bank_line_id) REFERENCES crove_finance.bank_line (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'cash_voucher_bank_line_type'
                   AND conrelid = 'crove_finance.cash_voucher'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.cash_voucher
      ADD CONSTRAINT cash_voucher_bank_line_type CHECK (bank_line_id IS NULL OR voucher_type IN ('bank_credit', 'bank_debit'));
  END IF;
END $$;

-- The vouchers of a line (the settled check below, the bank screen's state of each line).
CREATE INDEX IF NOT EXISTS cash_voucher_bank_line_idx ON crove_finance.cash_voucher (org_id, bank_line_id) WHERE bank_line_id IS NOT NULL;

-- Owned by the migration runner, like check_cash_voucher_entry (20261019270000), so it sees every voucher and journal
-- entry of the org whatever the writer can see. It reads only rows of NEW.org_id, a row that passed row security. Its
-- errors name ids only; finance.voucher.record checks the same rules first and words them for the user.
CREATE OR REPLACE FUNCTION crove_finance.check_cash_voucher_bank_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_line record;
BEGIN
  IF NEW.bank_line_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crove_finance.bank_line:' || NEW.org_id::text || ':' || NEW.bank_line_id::text, 0));
  SELECT l.bank_account, l.amount, l.value_date INTO v_line
  FROM crove_finance.bank_line l
  WHERE l.org_id = NEW.org_id AND l.id = NEW.bank_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank line % of cash voucher % is not a line of the org', NEW.bank_line_id, NEW.id USING ERRCODE = '23503';
  END IF;
  IF v_line.bank_account <> NEW.cash_account
     OR v_line.value_date <> NEW.voucher_date
     OR pg_catalog.abs(v_line.amount) <> NEW.amount
     OR (v_line.amount > 0) <> (NEW.voucher_type = 'bank_credit') THEN
    RAISE EXCEPTION 'cash voucher % does not match bank line % (account, date, amount or direction)', NEW.id, NEW.bank_line_id
      USING ERRCODE = '23514';
  END IF;
  -- Another voucher of the line whose entry is not reversed. A voucher without an entry cannot be committed
  -- (cash_voucher_entry), so every other voucher seen here has one.
  IF EXISTS (
    SELECT 1
    FROM crove_finance.cash_voucher v
    JOIN crove_finance.journal_entry e
      ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL
    WHERE v.org_id = NEW.org_id AND v.bank_line_id = NEW.bank_line_id AND v.id <> NEW.id
      AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id)
  ) THEN
    RAISE EXCEPTION 'bank line % is already settled by another cash voucher', NEW.bank_line_id USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS cash_voucher_settles_bank_line ON crove_finance.cash_voucher;
CREATE TRIGGER cash_voucher_settles_bank_line
  AFTER INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_cash_voucher_bank_line();

-- Trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.check_cash_voucher_bank_line() FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261019270000): the check must run as a role that row security does not filter on the tables it
-- reads, or it would miss a voucher or a reversal the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.check_cash_voucher_bank_line()'::pg_catalog.regprocedure
    AND c.oid IN ('crove_finance.journal_entry'::pg_catalog.regclass, 'crove_finance.cash_voucher'::pg_catalog.regclass,
                  'crove_finance.bank_line'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.check_cash_voucher_bank_line() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;
