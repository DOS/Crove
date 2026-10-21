-- Crove finance (issue #918): invoices issued in a foreign currency, booked in VND. TT133 books are kept in VND at the
-- rate of the transaction, so subtotal, vat_amount, total, the lines and the journal entry of such a document are in
-- VND (modules/finance/src/domain/foreign-currency.ts), and the document keeps what the invoice says:
-- - currency: the invoice's currency (DVTTe), as before;
-- - exchange_rate: VND per unit of it, the rate the amounts were converted at;
-- - exchange_rate_source: 'invoice' (the e-invoice's own TGia) or 'entered' (the accountant's, on a revision);
-- - foreign_subtotal, foreign_vat_amount, foreign_total: the invoice's totals in its currency.
-- A VND document has none of them; a document in any other currency has all of them. Documents recorded before #918
-- may spell VND in lower case (the table is append-only, so they stay as they are): the check compares it upper case,
-- and Crove now writes it upper case. Idempotent.
ALTER TABLE crove_finance.purchase_document
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(24,10),
  ADD COLUMN IF NOT EXISTS exchange_rate_source text,
  ADD COLUMN IF NOT EXISTS foreign_subtotal numeric(20,4),
  ADD COLUMN IF NOT EXISTS foreign_vat_amount numeric(20,4),
  ADD COLUMN IF NOT EXISTS foreign_total numeric(20,4);

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_exchange_rate_source CHECK (exchange_rate_source IN ('invoice', 'entered'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_foreign_amounts CHECK (
      (pg_catalog.upper(pg_catalog.btrim(currency)) = 'VND') = (exchange_rate IS NULL)
      AND (exchange_rate IS NULL) = (exchange_rate_source IS NULL)
      AND (exchange_rate IS NULL) = (foreign_subtotal IS NULL)
      AND (exchange_rate IS NULL) = (foreign_vat_amount IS NULL)
      AND (exchange_rate IS NULL) = (foreign_total IS NULL)
      AND (exchange_rate IS NULL OR exchange_rate > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
