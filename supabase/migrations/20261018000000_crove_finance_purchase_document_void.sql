-- Crove finance (issue #165): reversing the journal entry of a purchase document voids Crove's record of that
-- document, so the same supplier invoice can be recorded again with the right accounts.
-- This is an internal correction of Crove's own records. It does not touch the supplier's e-invoice, which stays
-- valid at the tax authority; correcting or cancelling that invoice is the supplier's business (adjustment or
-- replacement invoice). An accountant should confirm this treatment before Finance is charged for.
-- Documents stay append-only: a void is a separate append-only row that names the reversal entry it came from. A
-- document recorded again names the voided document it replaces, so at most one document per supplier invoice is
-- ever in force:
-- - purchase_document_invoice_uq: one document per (supplier, series, number) that replaces nothing;
-- - purchase_document_replaces_uq: each document is replaced at most once (of two concurrent re-records, the second
--   waits on the index and fails with a unique violation);
-- - a document may replace only a voided document of the same supplier invoice (check_document_replaces).
-- Idempotent, including the backfill of voids for purchase entries reversed before this migration.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.purchase_document_void (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  -- The reversal of the document's journal entry, posted in the same transaction (finance.journal.reverse).
  reversal_entry_id uuid NOT NULL,
  reason text NOT NULL CHECK (pg_catalog.length(reason) BETWEEN 1 AND 500),
  voided_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, document_id),
  UNIQUE (org_id, reversal_entry_id),
  -- NO ACTION, as for journal_entry_reverses_fk: checked at the end of the statement, so purging a whole org works.
  FOREIGN KEY (org_id, document_id) REFERENCES crove_finance.purchase_document (org_id, id) ON DELETE NO ACTION,
  FOREIGN KEY (org_id, reversal_entry_id) REFERENCES crove_finance.journal_entry (org_id, id) ON DELETE NO ACTION
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.purchase_document_void', true);
SELECT crove_kernel.make_append_only('crove_finance.purchase_document_void');

-- A void must name the reversal of the document's own journal entry. Runs as the writer: a writer that cannot see
-- both entries is refused (fail closed). The check holds for every writer, superusers included.
CREATE OR REPLACE FUNCTION crove_finance.check_document_void() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM crove_finance.journal_entry r
    JOIN crove_finance.journal_entry o ON o.org_id = r.org_id AND o.id = r.reverses_entry_id
    WHERE r.org_id = NEW.org_id AND r.id = NEW.reversal_entry_id
      AND o.source_type = 'finance.purchase_document' AND o.source_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'a void of purchase document % must name the reversal of its journal entry', NEW.document_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS purchase_document_void_reversal ON crove_finance.purchase_document_void;
CREATE TRIGGER purchase_document_void_reversal
  AFTER INSERT ON crove_finance.purchase_document_void
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_document_void();

-- Purchase entries reversed before this migration (since 20261016210000) void their documents now, as a reversal does
-- from here on. The reason is the reversal's description, which carries the reason given; voided_by is unknown.
INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason, voided_by, created_at)
SELECT r.org_id, o.source_id, r.id, pg_catalog.left(r.description, 500), NULL, r.created_at
FROM crove_finance.journal_entry r
JOIN crove_finance.journal_entry o ON o.org_id = r.org_id AND o.id = r.reverses_entry_id
JOIN crove_finance.purchase_document d ON d.org_id = o.org_id AND d.id = o.source_id
WHERE o.source_type = 'finance.purchase_document' AND pg_catalog.length(r.description) > 0
ON CONFLICT DO NOTHING;

-- A document recorded again names the voided document it replaces.
ALTER TABLE crove_finance.purchase_document ADD COLUMN IF NOT EXISTS replaces_document_id uuid;

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_replaces_fk FOREIGN KEY (org_id, replaces_document_id)
    REFERENCES crove_finance.purchase_document (org_id, id) ON DELETE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_finance.purchase_document
    ADD CONSTRAINT purchase_document_replaces_other CHECK (replaces_document_id IS DISTINCT FROM id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_document_replaces_uq
  ON crove_finance.purchase_document (org_id, replaces_document_id) WHERE replaces_document_id IS NOT NULL;

-- The duplicate check (DUPLICATE_INVOICE) now ignores voided documents only: the first document of a supplier
-- invoice replaces nothing and is unique here; every later one must replace a voided one (above and below). The
-- partial index is created before the table-wide constraint goes, so the rule never lapses.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_document_invoice_uq
  ON crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number) WHERE replaces_document_id IS NULL;
-- The table-wide UNIQUE (org_id, party_id, invoice_series, invoice_number) from 20261013120100, found by its columns
-- (its generated name is truncated).
DO $$
DECLARE
  v_name name;
BEGIN
  SELECT c.conname INTO v_name
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'crove_finance.purchase_document'::pg_catalog.regclass AND c.contype = 'u'
    AND ARRAY(
      SELECT a.attname::text FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) ORDER BY a.attname
    ) = ARRAY['invoice_number', 'invoice_series', 'org_id', 'party_id'];
  IF v_name IS NOT NULL THEN
    EXECUTE pg_catalog.format('ALTER TABLE crove_finance.purchase_document DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

-- Only a voided document of the same supplier invoice may be replaced. Runs as the writer (fail closed when the
-- voided document or its void is not visible). A void is append-only, so once seen it stays.
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
      AND d.party_id = NEW.party_id AND d.invoice_series = NEW.invoice_series AND d.invoice_number = NEW.invoice_number
  ) THEN
    RAISE EXCEPTION 'purchase document % may replace only a voided document of the same invoice', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_document_replaces ON crove_finance.purchase_document;
CREATE TRIGGER purchase_document_replaces
  BEFORE INSERT ON crove_finance.purchase_document
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_document_replaces();

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.check_document_void(), crove_finance.check_document_replaces() FROM PUBLIC;
