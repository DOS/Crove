-- Crove finance (issue #204): a reversal of a purchase document's journal entry commits only together with the void
-- of that document. 20261018000000 checks one direction (a void must name the reversal of its document's entry); this
-- adds the other: a reversal whose original records a purchase document (source_type 'finance.purchase_document')
-- must have, by commit, the purchase_document_void row that names it and that document. finance.journal.reverse
-- writes both in one transaction; any other writer (another command, a direct call of post_journal_entry() with
-- p_reverses_entry_id, a superuser) is held to the same rule, so the books never show a reversed purchase whose
-- document still counts as recorded.
-- Deferred to commit, so the void may follow the reversal within the transaction (it must: the void names the
-- reversal's id). A writer that fires it early (SET CONSTRAINTS ... IMMEDIATE) before writing the void is refused.
-- Only new rows are checked: purchase entries reversed before 20261018000000 got their voids from its backfill.
-- Idempotent.
SET LOCAL lock_timeout = '2s';

-- Owned by the migration runner, like the ledger checks (20261016210000), so it sees the original entry and the void
-- whatever the writer can see: a check run as the writer would pass when the writer cannot see the original (fail
-- open). Its error names ids only.
CREATE OR REPLACE FUNCTION crove_finance.require_reversal_void() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_document uuid;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT o.source_id INTO v_document
  FROM crove_finance.journal_entry o
  WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_entry_id AND o.source_type = 'finance.purchase_document';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_finance.purchase_document_void v
    WHERE v.org_id = NEW.org_id AND v.reversal_entry_id = NEW.id AND v.document_id = v_document
  ) THEN
    RAISE EXCEPTION 'reversal % of a purchase document entry must void purchase document % in the same transaction', NEW.id, v_document
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_entry_reversal_voids ON crove_finance.journal_entry;
CREATE CONSTRAINT TRIGGER journal_entry_reversal_voids
  AFTER INSERT ON crove_finance.journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.reverses_entry_id IS NOT NULL)
  EXECUTE FUNCTION crove_finance.require_reversal_void();

-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_finance.require_reversal_void() FROM PUBLIC, crove_tenant, crove_definer_tenant;

-- Drift guard (as in 20261016210000): the check must run as a role that row security does not filter on the tables it
-- reads, or it would miss an original or a void the writer cannot see.
DO $$
DECLARE
  v_table text;
BEGIN
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO v_table
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  CROSS JOIN pg_catalog.pg_class c
  WHERE p.oid = 'crove_finance.require_reversal_void()'::pg_catalog.regprocedure
    AND c.oid IN ('crove_finance.journal_entry'::pg_catalog.regclass, 'crove_finance.purchase_document_void'::pg_catalog.regclass)
    AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity));
  IF v_table IS NOT NULL THEN
    RAISE EXCEPTION 'crove_finance.require_reversal_void() must be owned by the owner of % (row security not forced), a superuser or a BYPASSRLS role', v_table;
  END IF;
END $$;
