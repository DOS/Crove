-- Crove finance (issue #1400): the VAT return 01/GTGT marked filed for a period, with the figures the next return
-- needs. Indicator [22] of a return (VAT still deductible, carried forward from the previous period) is the previous
-- return's [43] (VAT still deductible, carried to the next period); see docs/integrations/htkk-01gtgt-xml.md.
-- Idempotent; applied files stay untouched.
--
-- One row per mark, append-only: the latest row of a period (by created_at, then id) is its state, so a correction
-- or a withdrawal adds a row and the history stays, like the rest of the books. status:
--   - filed: the return of the period was marked done (the tax calendar's done mark, crove_kernel.tax_obligation_done,
--     is written in the same command), with [22], [25] and [43] as filed. source says where the figures come from:
--     'entered' (the accountant typed or confirmed them on the VAT screen) or 'computed' (marked done from the tax
--     calendar, so Crove's own working: [22] from the previous return, [25] the suggested deduction);
--   - withdrawn: the done mark was taken back; no figures.
-- finance.vat.return_mark (R1, audited) is the only writer; tenant roles read and insert, nobody updates or deletes.
-- Kept with the books: the org purge never deletes a crove_finance row.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.vat_return_filed (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- A month ("2026-09") or a quarter ("2026-Q3"), as finance.vat.period names it.
  period text NOT NULL CHECK (period ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2]|Q[1-4])$'),
  status text NOT NULL CHECK (status IN ('filed', 'withdrawn')),
  source text CHECK (source IN ('entered', 'computed')),
  -- [22], [25] and [43] in whole dong, as on the return (HTKK holds 14 digits).
  carried_in_amount crove_finance.amount,
  deductible_amount crove_finance.amount,
  carried_out_amount crove_finance.amount,
  marked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (org_id, id),
  -- A filed mark has a source and every figure; a withdrawal has none.
  CONSTRAINT vat_return_filed_figures CHECK (
    (status = 'filed' AND source IS NOT NULL AND carried_in_amount IS NOT NULL AND deductible_amount IS NOT NULL AND carried_out_amount IS NOT NULL)
    OR (status = 'withdrawn' AND source IS NULL AND carried_in_amount IS NULL AND deductible_amount IS NULL AND carried_out_amount IS NULL)
  ),
  CONSTRAINT vat_return_filed_amounts CHECK (
    (carried_in_amount IS NULL OR (carried_in_amount BETWEEN 0 AND 99999999999999 AND carried_in_amount = pg_catalog.trunc(carried_in_amount)))
    AND (deductible_amount IS NULL OR (deductible_amount BETWEEN 0 AND 99999999999999 AND deductible_amount = pg_catalog.trunc(deductible_amount)))
    AND (carried_out_amount IS NULL OR (carried_out_amount BETWEEN 0 AND 99999999999999 AND carried_out_amount = pg_catalog.trunc(carried_out_amount)))
  )
);

-- The latest mark of a period, and of the period before the one on screen.
CREATE INDEX IF NOT EXISTS vat_return_filed_period_idx ON crove_finance.vat_return_filed (org_id, period, created_at DESC, id DESC);

SELECT crove_kernel.apply_tenant_rls('crove_finance.vat_return_filed', true);
SELECT crove_kernel.make_append_only('crove_finance.vat_return_filed');
