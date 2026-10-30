-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #1928, from the review of #1338): a purchase or sale document is posted once.
-- Idempotent; applied files stay untouched.
--
-- A document has at most one void (crove_finance.purchase_document_void, primary key (org_id, document_id)), and the
-- reversal of its entry must void it in the same transaction (require_reversal_void). The posting path still accepted
-- revision 2 of a document whose revision 1 was reversed: revision 2 then counted in the ledger while the document
-- stayed voided, out of the VAT working and the MISA exports, and revision 2 could never be reversed, since its
-- reversal would need a second void. No caller posts a revision above 1, so no row is in that state.
--
-- Of the two ways out (#1928), this takes the one that changes no row and no rule of ADR-0021: a journal entry whose
-- source is a purchase or sale document (source_type 'finance.purchase_document', sales included) is revision 1, and
-- nothing else. A document posted wrong is reversed with its void, and the correct invoice is a new document: a
-- replacement or an adjustment invoice, linked to the original (#916). Every other source keeps its revisions (#1283).
--
-- A CHECK on crove_finance.journal_entry, so it holds for every writer: post_journal_entry, whose own checks (the next
-- revision, the previous one reversed) come first, and the database owner alike. Added NOT VALID here, which holds
-- every new row to it at once and reads no existing row, so the table is locked only for the catalog change. The next
-- migration (20261107120000_crove_finance_document_one_revision_validate.sql) validates it in a transaction of its own,
-- under SHARE UPDATE EXCLUSIVE, so postings go on during the scan.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'crove_finance.journal_entry'::pg_catalog.regclass AND conname = 'journal_entry_document_one_revision') THEN
    ALTER TABLE crove_finance.journal_entry
      ADD CONSTRAINT journal_entry_document_one_revision CHECK (source_type <> 'finance.purchase_document' OR source_revision = 1) NOT VALID;
  END IF;
END $$;
