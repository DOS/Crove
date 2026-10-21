-- Crove finance (issue #916): an e-invoice that corrects another. A supplier (or the org, for a sale) corrects an
-- invoice it issued with a replacement invoice (thay thế), which takes the original's place, or an adjustment invoice
-- (điều chỉnh), which changes its amounts by the difference it carries. Its XML names the original (TTHDLQuan); the
-- document recorded from it keeps that reference, and the original's document when it is in the books:
-- - correction_kind: 'replacement' or 'adjustment'; NULL on every other document.
-- - corrected_series, corrected_number, corrected_date: the original as the invoice names it, kept whether or not
--   the original is in the books.
-- - corrects_document_id: the original's document, when it is recorded. A replacement's original is voided (its
--   entry reversed) before the replacement is recorded, in the same transaction (modules/finance/src/record.ts); an
--   adjustment's original stays in force. At most one replacement per original.
-- This is not replaces_document_id (20261018000000): that one is the same invoice recorded again after Crove voided
-- its document, and it must carry the same series and number.
ALTER TABLE crove_finance.purchase_document
  ADD COLUMN IF NOT EXISTS correction_kind text,
  ADD COLUMN IF NOT EXISTS corrects_document_id uuid,
  ADD COLUMN IF NOT EXISTS corrected_series text,
  ADD COLUMN IF NOT EXISTS corrected_number text,
  ADD COLUMN IF NOT EXISTS corrected_date date;

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_correction_kind CHECK (correction_kind IN ('replacement', 'adjustment'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The reference comes with its kind, and a link only with a reference.
DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_correction_ref CHECK (
      (correction_kind IS NULL) = (corrected_number IS NULL)
      AND (correction_kind IS NULL) = (corrected_series IS NULL)
      AND (corrects_document_id IS NULL OR correction_kind IS NOT NULL)
      AND corrects_document_id IS DISTINCT FROM id
      AND (corrected_series IS NULL OR pg_catalog.char_length(corrected_series) <= 50)
      AND (corrected_number IS NULL OR pg_catalog.char_length(corrected_number) <= 50)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_corrects_fk FOREIGN KEY (org_id, corrects_document_id)
    REFERENCES crove_finance.purchase_document (org_id, id) ON DELETE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS purchase_document_corrects_idx
  ON crove_finance.purchase_document (org_id, corrects_document_id) WHERE corrects_document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_document_replacement_uq
  ON crove_finance.purchase_document (org_id, corrects_document_id) WHERE correction_kind = 'replacement';

-- The linked original is the invoice the reference names, in the same direction (and from the same supplier for a
-- purchase); a replacement's original is already voided, an adjustment's is still in force. Runs as the writer, as
-- check_document_replaces() does: the original is a document of the same org.
CREATE OR REPLACE FUNCTION crove_finance.check_document_corrects() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_voided boolean;
BEGIN
  IF NEW.corrects_document_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id
  ) INTO v_voided
  FROM crove_finance.purchase_document d
  WHERE d.org_id = NEW.org_id AND d.id = NEW.corrects_document_id
    AND d.direction = NEW.direction
    AND (NEW.direction = 'sale' OR d.party_id = NEW.party_id)
    AND d.invoice_series = NEW.corrected_series AND d.invoice_number = NEW.corrected_number;
  IF v_voided IS NULL THEN
    RAISE EXCEPTION 'purchase document % may correct only the document of the invoice it names', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF v_voided <> (NEW.correction_kind = 'replacement') THEN
    RAISE EXCEPTION 'purchase document %: a replacement corrects a voided document, an adjustment one in force', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_document_corrects ON crove_finance.purchase_document;
CREATE TRIGGER purchase_document_corrects
  BEFORE INSERT ON crove_finance.purchase_document
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_document_corrects();

-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.check_document_corrects() FROM PUBLIC, crove_tenant, crove_definer_tenant;
