-- Crove finance (issue #685): the per-rate VAT table of an e-invoice (THTTLTSuat: for each rate, the taxable value and
-- the VAT the seller declared), stored with the recorded document. The VAT working (modules/finance/src/vat.ts) uses it
-- for the invoice's split by rate instead of estimating the VAT of each rate from the lines; documents recorded before
-- this table, and documents read from a PDF or an image, have no rows and keep the estimate. Idempotent.
--
-- crove_finance.purchase_tax_rate   one row per row of the invoice's table, in the invoice's order. vat_rate is the
--                                    rate as the invoice writes it ("10%", "8%", "KCT", "KHAC:3.5%"), like
--                                    purchase_line.vat_rate; the VAT working places it in a rate bucket. Append-only,
--                                    like the rest of the document's facts.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.purchase_tax_rate (
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  row_no integer NOT NULL CHECK (row_no BETWEEN 1 AND 100),
  vat_rate text NOT NULL CHECK (pg_catalog.length(vat_rate) <= 20),
  taxable_amount crove_finance.amount NOT NULL,
  vat_amount crove_finance.amount NOT NULL,
  PRIMARY KEY (org_id, document_id, row_no),
  -- ON DELETE CASCADE as on purchase_line. It never takes effect: documents are append-only, and a cascade would be
  -- refused by the rows' append-only trigger anyway.
  CONSTRAINT purchase_tax_rate_document_fk FOREIGN KEY (org_id, document_id) REFERENCES crove_finance.purchase_document (org_id, id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.purchase_tax_rate', true);
SELECT crove_kernel.make_append_only('crove_finance.purchase_tax_rate');

-- The table joins its document only while the document is being recorded: finance.purchase.record writes it before it
-- posts the document's journal entry, and a document commits only with that entry (purchase_document_entry, #560). So
-- once a document is recorded nobody can add rows to it and change its split by rate after the fact. Runs as the
-- writer: row security keeps a tenant writer in its own org, where the foreign key puts the document too.
CREATE OR REPLACE FUNCTION crove_finance.purchase_tax_rate_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM crove_finance.journal_entry e
    WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'purchase document % is already posted; its VAT table is written only with the document', NEW.document_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_tax_rate_before_insert ON crove_finance.purchase_tax_rate;
CREATE TRIGGER purchase_tax_rate_before_insert
  BEFORE INSERT ON crove_finance.purchase_tax_rate
  FOR EACH ROW EXECUTE FUNCTION crove_finance.purchase_tax_rate_before_insert();

-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.purchase_tax_rate_before_insert() FROM PUBLIC;
