-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #1928): validates journal_entry_document_one_revision, added NOT VALID by
-- 20261107110000_crove_finance_document_one_revision.sql. Idempotent (validating a valid constraint does nothing).
--
-- Its own file, so its own transaction: the previous file's ACCESS EXCLUSIVE lock is released before this scan, which
-- holds SHARE UPDATE EXCLUSIVE only, so postings and reads go on meanwhile. A database holding an entry of a purchase
-- or sale document at a revision above 1 refuses the validation and this migration with it; no caller writes one, so
-- such a row was written by hand and is fixed by hand (#1928 says how a document is corrected).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.journal_entry VALIDATE CONSTRAINT journal_entry_document_one_revision;
