-- Crove finance (issue #313): sales (output) e-invoices. A sale reuses the purchase pipeline end to end: the same
-- document and line tables, the same journal link (source_type 'finance.purchase_document' names a row of
-- crove_finance.purchase_document, whatever its direction), the same void by reversal and the same re-recording of a
-- voided document. So the rules of 20261018000000 hold for sales too without a second copy. What differs is recorded
-- here:
-- - purchase_document.direction: 'purchase' (the org bought; party_id is the seller) or 'sale' (the org issued the
--   invoice; party_id is the customer). Every existing row is a purchase.
-- - purchase_line.credit_account: the revenue account a sale line is credited to (511 by default). A purchase line
--   keeps its debit_account. Each line has exactly one of the two, the one of its document's direction (checked by a
--   trigger for every writer), and that code is a TT133 account or a sub-account of the line's org (check_account_ref,
--   as for debit_account since 20261019060000).
-- - Duplicates: a purchase is one per (supplier, series, number), as before; a sale is one per (series, number), since
--   the org itself numbers its own invoices whoever the customer is.
-- - A voided document may be replaced only by one of the same direction.
-- The table keeps its name: renaming it would touch every reader for no change in behavior (a later cleanup).
-- Idempotent.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.purchase_document ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'purchase';

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_direction_check CHECK (direction IN ('purchase', 'sale'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE crove_finance.purchase_line ADD COLUMN IF NOT EXISTS credit_account text;
ALTER TABLE crove_finance.purchase_line ALTER COLUMN debit_account DROP NOT NULL;

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_line
    ADD CONSTRAINT purchase_line_one_account CHECK (pg_catalog.num_nonnulls(debit_account, credit_account) = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A purchase line names its debit account, a sale line its credit account. Runs as the writer: a document the writer
-- cannot see (another org's, or none) is left to the foreign key and row security, which both refuse the line.
CREATE OR REPLACE FUNCTION crove_finance.check_line_direction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_direction text;
BEGIN
  SELECT d.direction INTO v_direction
  FROM crove_finance.purchase_document d
  WHERE d.org_id = NEW.org_id AND d.id = NEW.document_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (v_direction = 'purchase' AND NEW.debit_account IS NULL) OR (v_direction = 'sale' AND NEW.credit_account IS NULL) THEN
    RAISE EXCEPTION 'line % of document % must name the account of the document''s direction', NEW.line_no, NEW.document_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_line_direction ON crove_finance.purchase_line;
CREATE TRIGGER purchase_line_direction
  BEFORE INSERT ON crove_finance.purchase_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_line_direction();

-- The account reference check of 20261019060000, unchanged but for a purchase line's code: its debit account or, on a
-- sale line, its credit account (exactly one is set, purchase_line_one_account).
CREATE OR REPLACE FUNCTION crove_finance.check_account_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_code text;
  v_active boolean;
BEGIN
  -- Separate statements: an expression naming a column the table does not have fails even in a branch not taken.
  IF TG_TABLE_NAME = 'journal_line' THEN
    v_code := NEW.account_code;
  ELSIF TG_TABLE_NAME = 'purchase_line' THEN
    v_code := COALESCE(NEW.debit_account, NEW.credit_account);
  ELSE
    v_code := NEW.debit_account;
  END IF;
  IF EXISTS (SELECT 1 FROM crove_finance.account a WHERE a.code = v_code) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'vendor_account_rule' THEN
    SELECT o.active INTO v_active FROM crove_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code = v_code FOR SHARE;
  ELSE
    SELECT o.active INTO v_active FROM crove_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code = v_code;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "%" violates foreign key check: account % is not in the chart of accounts of org %',
      TG_TABLE_NAME, v_code, NEW.org_id USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME = 'vendor_account_rule' AND NOT v_active THEN
    RAISE EXCEPTION 'sub-account % is inactive and cannot be a vendor default', v_code USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END $$;

-- Only a voided document of the same invoice and the same direction may be replaced (20261018000000, plus the
-- direction). The same invoice is the same supplier, series and number for a purchase, and the same series and number
-- for a sale (the duplicate rules below). Runs as the writer, as before.
CREATE OR REPLACE FUNCTION crove_finance.check_document_replaces() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.replaces_document_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_finance.purchase_document d
    JOIN crove_finance.purchase_document_void v ON v.org_id = d.org_id AND v.document_id = d.id
    WHERE d.org_id = NEW.org_id AND d.id = NEW.replaces_document_id
      AND d.direction = NEW.direction
      AND (NEW.direction = 'sale' OR d.party_id = NEW.party_id)
      AND d.invoice_series = NEW.invoice_series AND d.invoice_number = NEW.invoice_number
  ) THEN
    RAISE EXCEPTION 'purchase document % may replace only a voided document of the same invoice', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.check_line_direction(), crove_finance.check_document_replaces() FROM PUBLIC;
REVOKE ALL ON FUNCTION crove_finance.check_line_direction(), crove_finance.check_account_ref()
  FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- One document per invoice that replaces nothing: per supplier for a purchase, per series and number for a sale. A
-- purchase from a party and a sale to the same party may carry the same series and number (each issuer numbers its
-- own invoices). The new indexes are created before the old one goes, so the rule never lapses.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_document_purchase_invoice_uq
  ON crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number)
  WHERE replaces_document_id IS NULL AND direction = 'purchase';
CREATE UNIQUE INDEX IF NOT EXISTS purchase_document_sale_invoice_uq
  ON crove_finance.purchase_document (org_id, invoice_series, invoice_number)
  WHERE replaces_document_id IS NULL AND direction = 'sale';
DROP INDEX IF EXISTS crove_finance.purchase_document_invoice_uq;

-- The documents list and the VAT working read by direction.
CREATE INDEX IF NOT EXISTS purchase_document_direction_date_idx ON crove_finance.purchase_document (org_id, direction, invoice_date);
