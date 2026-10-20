-- Crove finance (issue #560, review of #558): every purchase document has its journal entry. The VAT working
-- (modules/finance/src/vat.ts) picks the input side by the entry's date (#478) and so inner-joins journal_entry for both
-- directions; a document without its entry would drop out of the VAT working without a word. finance.purchase.record
-- writes the document and its entry in one transaction, but nothing held another writer (another command, a raw
-- statement, the database owner) to it. Now, for every writer that runs with triggers enabled (a superuser can still
-- step around it with session_replication_role = replica or DISABLE TRIGGER, as around every trigger):
-- - purchase_document_entry (deferred to commit): a purchase or sales document commits only together with its own
--   journal entry, source_type 'finance.purchase_document' and source_id the document, not a reversal. Deferred, since
--   the entry names the document's id and is posted after it (it must be). A writer that fires it early (SET
--   CONSTRAINTS ... IMMEDIATE) before posting the entry is refused.
-- - Rows already there are checked once below: a document without its entry stops the migration, naming how many, so
--   it is fixed (posted or explained) rather than silently left out of a return.
-- The entry is append-only and cannot be deleted (make_append_only), so once committed the pair stays. Idempotent.
SET LOCAL lock_timeout = '2s';

-- Owned by the migration runner, like the ledger checks (20261016210000) and the cash voucher check (20261019270000),
-- so it sees the entry whatever the writer can see. Its error names ids only.
CREATE OR REPLACE FUNCTION crove_finance.check_purchase_document_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry e
    WHERE e.org_id = NEW.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = NEW.id
      AND e.reverses_entry_id IS NULL
  ) THEN
    RAISE EXCEPTION 'purchase document % must be posted as a journal entry in the same transaction', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS purchase_document_entry ON crove_finance.purchase_document;
CREATE CONSTRAINT TRIGGER purchase_document_entry
  AFTER INSERT ON crove_finance.purchase_document
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_purchase_document_entry();

-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.check_purchase_document_entry() FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261018150000): the check must run as a role that row security does not filter on
-- journal_entry, or it would miss the entry of a document whose writer cannot see it.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.check_purchase_document_entry()'::pg_catalog.regprocedure
    AND c.oid = 'crove_finance.journal_entry'::pg_catalog.regclass
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.check_purchase_document_entry() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;

-- The documents recorded before this migration: each must already have its entry (finance.purchase.record has always
-- written both in one transaction). Read as the migration runner, which owns both tables, so row security hides none.
DO $$
DECLARE
  v_missing bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO v_missing
  FROM crove_finance.purchase_document d
  WHERE NOT EXISTS (
    SELECT 1 FROM crove_finance.journal_entry e
    WHERE e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
      AND e.reverses_entry_id IS NULL
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% purchase document(s) have no journal entry; post or explain them before this migration (#560)', v_missing
      USING ERRCODE = '23514';
  END IF;
END $$;
