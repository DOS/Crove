-- Crove Notes (issue #1672, plan docs/plan/notes.md §3.4 and step N3, ADR-0037): a note links to a purchase document,
-- a journal entry or a booking as well as to a party or a file. Idempotent; applied files stay untouched.
--
-- No foreign key goes to another module's schema (plan §5.5, G3): a finance or crm target is checked when the link is
-- made, by running that module's own get query in the writer's context (its RBAC and le_scope apply), and read the
-- same way when a link is shown, so a reader who cannot open the record, or a deployment without the module, sees it
-- as "Bản ghi không mở được". These records are never deleted by a tenant (the ledger and the documents are append-only,
-- a booking is cancelled, not removed); the org purge deletes crove_notes before them. Their link rows keep party_id
-- and file_id empty, as the widened link_target_ck says.
--
-- Widening a CHECK refuses no row written before, so the constraints are dropped and added again in this transaction;
-- the link table is small and new (N2), and the lock_timeout bounds the wait for its lock.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_notes.link DROP CONSTRAINT IF EXISTS link_target_type_check;
ALTER TABLE crove_notes.link ADD CONSTRAINT link_target_type_check
  CHECK (target_type IN ('kernel.party', 'kernel.file', 'finance.purchase_document', 'finance.journal_entry', 'crm.booking'));

ALTER TABLE crove_notes.link DROP CONSTRAINT IF EXISTS link_target_ck;
ALTER TABLE crove_notes.link ADD CONSTRAINT link_target_ck CHECK (
  (target_type = 'kernel.party' AND party_id = target_id AND file_id IS NULL)
  OR (target_type = 'kernel.file' AND file_id = target_id AND party_id IS NULL)
  OR (target_type IN ('finance.purchase_document', 'finance.journal_entry', 'crm.booking') AND party_id IS NULL AND file_id IS NULL));
