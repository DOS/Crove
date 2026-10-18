-- Crove finance (issue #327): cash and bank vouchers, the four TT133 money documents of a small firm:
--   cash_receipt  phiếu thu  (PT): money into the cash box (111): Dr 111x, Cr the lines (131 by default)
--   cash_payment  phiếu chi  (PC): money out of the cash box (111): Dr the lines (331 by default), Cr 111x
--   bank_credit   giấy báo Có (BC): money into a bank account (112): Dr 112x, Cr the lines (131 by default)
--   bank_debit    giấy báo Nợ (BN): money out of a bank account (112): Dr the lines (331 by default), Cr 112x
-- A voucher is posted through the posting path like every entry (finance.voucher.record, run only by approving its
-- proposal), and its journal entry names it (source_type 'finance.cash_voucher', source_id the voucher's id). Its
-- counter lines (the accounts settled: 131, 331, 6422 ...) live in that entry only; this table holds what the entry
-- does not: the type, the number, the cash or bank account, the party, the payer or payee and the reason.
-- Rules held by the database for every writer:
-- - numbering: one gapless sequence per org and type (PT 1, 2, 3 ... and PC 1, 2, 3 ...), assigned by the insert
--   trigger under a transaction-level advisory lock for that org and type, so two postings at once never take the same
--   number and a rolled-back posting leaves no gap; the unique key is the backstop. The caller's number is ignored.
-- - the cash account matches the type: 111 or a sub-account of it (1111, 1111.HCM) for cash vouchers, 112 or a
--   sub-account (1121, 1121.VCB) for bank vouchers. Every account code extends its parent's (20261019060000), so the
--   first three characters are always the TT133 level-1 account.
-- - by commit, the voucher has its journal entry, dated the voucher's date, whose lines on the cash account net to the
--   amount on the voucher's side (a debit for receipts and bank credits, a credit for payments and bank debits). The
--   entry's lines are checked against the chart of accounts by the ledger's own triggers, so the cash account is a
--   real account of the org too.
-- - vouchers are append-only: a mistake is corrected by reversing the voucher's entry (finance.journal.reverse); the
--   voucher keeps its number and shows as reversed.
-- Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.cash_voucher (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  voucher_type text NOT NULL CHECK (voucher_type IN ('cash_receipt', 'cash_payment', 'bank_credit', 'bank_debit')),
  -- Assigned by cash_voucher_before_insert.
  number integer NOT NULL CHECK (number > 0),
  voucher_date date NOT NULL,
  cash_account text NOT NULL,
  -- The customer, vendor or other party paid or paying; required by the command when a line settles 131 or 331.
  party_id uuid,
  -- Người nộp tiền / người nhận tiền as written on the voucher, when it is not the party itself.
  person_name text CHECK (person_name IS NULL OR pg_catalog.length(pg_catalog.btrim(person_name)) BETWEEN 1 AND 200),
  -- Lý do thu / lý do chi.
  description text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(description)) BETWEEN 1 AND 300),
  amount crove_finance.amount NOT NULL CHECK (amount > 0),
  proposal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT cash_voucher_number_uq UNIQUE (org_id, voucher_type, number),
  CONSTRAINT cash_voucher_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id),
  CONSTRAINT cash_voucher_account_matches_type CHECK (
    (voucher_type IN ('cash_receipt', 'cash_payment') AND pg_catalog.left(cash_account, 3) = '111')
    OR (voucher_type IN ('bank_credit', 'bank_debit') AND pg_catalog.left(cash_account, 3) = '112')
  )
);
-- One voucher per approved proposal.
CREATE UNIQUE INDEX IF NOT EXISTS cash_voucher_proposal_uq ON crove_finance.cash_voucher (org_id, proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_voucher_date_idx ON crove_finance.cash_voucher (org_id, voucher_date DESC);
CREATE INDEX IF NOT EXISTS cash_voucher_party_idx ON crove_finance.cash_voucher (org_id, party_id) WHERE party_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_finance.cash_voucher', true);
SELECT crove_kernel.make_append_only('crove_finance.cash_voucher');

-- The next number of the org and type. Runs as the writer: an org's vouchers are all visible to it (row security is by
-- org), and should a later policy hide some, the unique key refuses the duplicate rather than reusing a number. The
-- lock is released at commit or rollback, so the next posting of the same org and type reads this one's number.
CREATE OR REPLACE FUNCTION crove_finance.cash_voucher_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('crove_finance.cash_voucher:' || NEW.org_id::text || ':' || NEW.voucher_type, 0));
  SELECT coalesce(pg_catalog.max(v.number), 0) + 1 INTO NEW.number
  FROM crove_finance.cash_voucher v
  WHERE v.org_id = NEW.org_id AND v.voucher_type = NEW.voucher_type;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cash_voucher_number ON crove_finance.cash_voucher;
CREATE TRIGGER cash_voucher_number
  BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.cash_voucher_before_insert();

-- By commit, the voucher's journal entry exists, on the voucher's date, and its lines on the cash account net to the
-- amount on the voucher's side. Owned by the migration runner, like the ledger checks (20261016210000), so it sees
-- every line of the entry whatever the writer can see. Its error names ids only.
CREATE OR REPLACE FUNCTION crove_finance.check_cash_voucher_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entry uuid;
  v_net numeric;
BEGIN
  SELECT e.id INTO v_entry
  FROM crove_finance.journal_entry e
  WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = NEW.id
    AND e.reverses_entry_id IS NULL AND e.entry_date = NEW.voucher_date;
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

DROP TRIGGER IF EXISTS cash_voucher_entry ON crove_finance.cash_voucher;
CREATE CONSTRAINT TRIGGER cash_voucher_entry
  AFTER INSERT ON crove_finance.cash_voucher
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_cash_voucher_entry();

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.cash_voucher_before_insert(), crove_finance.check_cash_voucher_entry()
  FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261018150000): the entry check must run as a role that row security does not filter on the
-- ledger tables, or it would miss lines the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.check_cash_voucher_entry()'::pg_catalog.regprocedure
    AND c.oid IN ('crove_finance.journal_entry'::pg_catalog.regclass, 'crove_finance.journal_line'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.check_cash_voucher_entry() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;

