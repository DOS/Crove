-- Crove finance (issue #888): general journal vouchers, phiếu kế toán khác (NVK). A user enters a balanced entry by
-- hand (accruals, salaries, depreciation, reclassifications); approving its proposal numbers the voucher and posts its
-- journal entry (modules/finance/src/journal-voucher.ts). The lines live in that entry only; this table holds what the
-- entry does not: the number and the proposal it came from.
--
-- - numbering: one gapless sequence per org (NVK 1, 2, 3 ...), assigned by the insert under a per-org advisory lock,
--   so concurrent postings take turns and a rolled-back posting leaves no gap; the unique key is the backstop. The
--   caller's number is ignored.
-- - append-only: a voucher is corrected by reversing its entry (finance.journal.reverse); it keeps its number.
-- - by commit, the voucher has its journal entry (source finance.journal_voucher, not a reversal, dated the voucher's
--   date), as cash vouchers do (20261019270000). The ledger's own checks keep that entry balanced.
CREATE TABLE IF NOT EXISTS crove_finance.journal_voucher (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  number integer NOT NULL CHECK (number > 0),
  voucher_date date NOT NULL,
  description text NOT NULL CHECK (pg_catalog.char_length(description) BETWEEN 1 AND 300),
  proposal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT journal_voucher_number_uq UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS journal_voucher_date_idx ON crove_finance.journal_voucher (org_id, voucher_date DESC, id DESC);

SELECT crove_kernel.apply_tenant_rls('crove_finance.journal_voucher', true);
SELECT crove_kernel.make_append_only('crove_finance.journal_voucher');

-- The next number of the org. Runs as the writer: an org's vouchers are all visible to it (row security is by org), and
-- should a later policy hide some, the unique key refuses the duplicate rather than reusing a number. The lock is
-- released at commit or rollback, so the next posting of the same org reads this one's number.
CREATE OR REPLACE FUNCTION crove_finance.journal_voucher_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove_finance.journal_voucher:' || NEW.org_id::text, 0));
  SELECT coalesce(pg_catalog.max(v.number), 0) + 1 INTO NEW.number
  FROM crove_finance.journal_voucher v
  WHERE v.org_id = NEW.org_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_voucher_number ON crove_finance.journal_voucher;
CREATE TRIGGER journal_voucher_number
  BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.journal_voucher_before_insert();

-- By commit, the voucher's journal entry exists, on the voucher's date. Owned by the migration runner, like the ledger
-- checks, so it sees the entry whatever the writer can see. Its error names ids only.
CREATE OR REPLACE FUNCTION crove_finance.check_journal_voucher_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry e
    WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = NEW.id
      AND e.reverses_entry_id IS NULL AND e.entry_date = NEW.voucher_date
  ) THEN
    RAISE EXCEPTION 'journal voucher % must be posted as a journal entry dated % in the same transaction', NEW.id, NEW.voucher_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_voucher_entry ON crove_finance.journal_voucher;
CREATE CONSTRAINT TRIGGER journal_voucher_entry
  AFTER INSERT ON crove_finance.journal_voucher
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_journal_voucher_entry();

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.journal_voucher_before_insert(), crove_finance.check_journal_voucher_entry()
  FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261019270000): the entry check must run as a role that row security does not filter on the
-- ledger tables, or it would miss an entry the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.check_journal_voucher_entry()'::pg_catalog.regprocedure
    AND c.oid = 'crove_finance.journal_entry'::pg_catalog.regclass
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.check_journal_voucher_entry() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;
