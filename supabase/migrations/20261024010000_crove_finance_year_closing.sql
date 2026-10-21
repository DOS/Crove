-- Crove finance (issue #889): the year-end closing entries (kết chuyển) are a general journal voucher (NVK, #888)
-- that names the fiscal year it closes. finance.closing.record (modules/finance/src/year-closing.ts) refuses a second
-- closing of a year whose closing entry stands (not reversed); reversing the closing entry opens the year again.
ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS closing_year smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_closing_year' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    -- A closing voucher is dated in the year it closes (on its last day, by the command).
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_closing_year CHECK (closing_year IS NULL OR closing_year = pg_catalog.date_part('year', voucher_date)::int);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS journal_voucher_closing_idx ON crove_finance.journal_voucher (org_id, closing_year) WHERE closing_year IS NOT NULL;
