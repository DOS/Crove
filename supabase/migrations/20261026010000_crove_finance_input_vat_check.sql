-- Crove finance (issue #917): the accountant's marks on input invoices that need proof of non-cash payment before
-- their VAT may be deducted (a purchase at or above the threshold of its date, not shown as paid by bank; the rule is
-- in modules/finance/src/domain/non-cash-payment.ts). Idempotent; applied files stay untouched.
--
-- One row per mark, append-only: the latest mark of a document (by created_at, then id) is its state, so a change of
-- mind adds a row and the history stays. outcome:
--   - paid_by_bank: the accountant saw the non-cash payment; voucher_id may name the bank voucher (báo Nợ) that paid it;
--   - not_deductible: no such proof, so its VAT stays out of the suggested [25];
--   - cleared: back to unchecked.
-- finance.vat.payment_mark (R1, audited) is the only writer; tenant roles read and insert, nobody updates or deletes.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.input_vat_check (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  document_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('paid_by_bank', 'not_deductible', 'cleared')),
  voucher_id uuid,
  note text CHECK (note IS NULL OR pg_catalog.length(note) BETWEEN 1 AND 500),
  marked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT input_vat_check_document_fk FOREIGN KEY (org_id, document_id) REFERENCES crove_finance.purchase_document (org_id, id),
  CONSTRAINT input_vat_check_voucher_fk FOREIGN KEY (org_id, voucher_id) REFERENCES crove_finance.cash_voucher (org_id, id),
  -- Only a payment by bank names a voucher.
  CONSTRAINT input_vat_check_voucher_outcome CHECK (voucher_id IS NULL OR outcome = 'paid_by_bank')
);

-- The latest mark of each document of a period.
CREATE INDEX IF NOT EXISTS input_vat_check_document_idx ON crove_finance.input_vat_check (org_id, document_id, created_at DESC, id DESC);

SELECT crove_kernel.apply_tenant_rls('crove_finance.input_vat_check', true);
SELECT crove_kernel.make_append_only('crove_finance.input_vat_check');
