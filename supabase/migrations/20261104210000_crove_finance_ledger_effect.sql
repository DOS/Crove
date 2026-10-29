-- Crove finance (issue #1842, option 3 of #1840): whether a ledger command's effect was posted in this transaction for a
-- proposal, so the kernel's proposal_status_guard can require it before an approved ledger proposal moves to 'executed'.
-- Idempotent; applied files stay untouched.
--
-- #1816 made approved -> executed need the ok audit row of the proposal's command, written in the same transaction by
-- the same actor. A session with raw SQL on the runtime's connection, as an eligible approver, can still write that row
-- itself and mark the proposal executed without running the command (#1840): the proposal reads as done and nothing was
-- posted. For the money paths the command's effect is state the session cannot fake by that row alone: every ledger
-- command (crove_kernel.approval_command_policy(...).ledger) posts at least one journal entry for the proposal, in the
-- execution's transaction (journal_entry.created_xact_id, set by the posting trigger, 20261014090100):
--   finance.purchase.record                       an entry of source finance.purchase_document whose document names the
--                                                 proposal (purchase_document.proposal_id), purchases and sales alike
--   finance.voucher.record                        an entry of source finance.cash_voucher whose voucher names it
--   finance.journal_voucher.record, finance.closing.record, finance.depreciation.record
--                                                 an entry of source finance.journal_voucher whose voucher names it (the
--                                                 closing and the depreciation post through postJournalVoucher)
--   finance.journal.reverse                       the reversal entry itself, source kernel.proposal, source_id the proposal
--
-- crove_finance.ledger_effect_recorded(org, proposal, command)
--   For the org of the caller's sealed context only (another org, or no context, answers false). True when the command
--   is not a ledger command (no effect to require), or when an entry of the org posted in this transaction is tied to
--   the proposal through the command's path above; false otherwise, and for a ledger command with no path here (a new
--   ledger command fails closed until it is listed). A definer, so it reads the rows whatever the writer's scope;
--   EXECUTE for crove_tenant, since proposal_status_guard runs as the writer. It answers a yes or no, never a row.
--
-- Two partial indexes give the lookups by proposal of the documents and journal vouchers (cash vouchers have one,
-- cash_voucher_proposal_uq); the entries are found through journal_entry_source_revision_key.
--
-- What stays: a raw session can still post the effect rows by hand, within the ledger's own guards (balanced lines, an
-- open period, the posting definer), as it could without any proposal; this makes "executed with no effect" impossible
-- for the money paths, not a forged effect.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS purchase_document_proposal_idx ON crove_finance.purchase_document (org_id, proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_voucher_proposal_idx ON crove_finance.journal_voucher (org_id, proposal_id) WHERE proposal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_finance.ledger_effect_recorded(p_org uuid, p_proposal uuid, p_command text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8 := pg_catalog.pg_current_xact_id();
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  IF NOT coalesce((crove_kernel.approval_command_policy(p_command)).ledger, false) THEN
    RETURN true;
  END IF;
  RETURN CASE
    WHEN p_command = 'finance.journal.reverse' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_entry e
      WHERE e.org_id = p_org AND e.source_type = 'kernel.proposal' AND e.source_id = p_proposal AND e.created_xact_id = v_xact)
    WHEN p_command = 'finance.purchase.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.purchase_document d
      JOIN crove_finance.journal_entry e ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
      WHERE d.org_id = p_org AND d.proposal_id = p_proposal AND e.created_xact_id = v_xact)
    WHEN p_command = 'finance.voucher.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact)
    WHEN p_command IN ('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact)
    ELSE false
  END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) TO crove_tenant;
