-- Crove finance (issue #1853, from the security review of #1848): a ledger row that names a proposal names one being
-- executed by its own command. Idempotent; applied files stay untouched.
--
-- #1842 asks a ledger proposal's move to 'executed' for its command's effect in the same transaction: a journal entry
-- tied to the proposal through the purchase document, cash voucher or journal voucher that names it (proposal_id), or
-- the reversal entry whose source is the proposal (source_type 'kernel.proposal', source_id). Nothing checked that the
-- proposal named there is real, so a raw session on the runtime's connection could write such a row naming any
-- proposal, of any state or command, of any org it could name. Every legitimate writer is the proposal's own command,
-- run by the runtime only while the proposal is 'approved' for it (the proposal state gate, requireProposalState):
--   crove_finance.purchase_document   finance.purchase.record (purchases and sales alike)
--   crove_finance.cash_voucher        finance.voucher.record
--   crove_finance.journal_voucher     finance.journal_voucher.record, finance.closing.record, finance.depreciation.record
--   crove_finance.journal_entry       a reversal entry (source_type 'kernel.proposal'): finance.journal.reverse, and
--                                     finance.purchase.record when a replacement invoice reverses its original's entry
--                                     (#916, postReversal)
-- The three tables are append-only (make_append_only), so a row's proposal_id is checked once, on insert.
--
-- crove_finance.effect_proposal_check()  BEFORE INSERT on the three tables, with the table's commands as trigger
--     arguments: a proposal_id that is set must name a proposal of the org of the writer's sealed context, of the row's
--     org, 'approved' (being executed), whose command is one of them. The proposal is read as the writer, so one its
--     scope cannot see is refused as well.
-- crove_finance.effect_proposal_entry_check()  BEFORE INSERT on journal_entry, the same for an entry of source
--     kernel.proposal, with the two commands above. Entries are inserted by the posting definer
--     (post_journal_entry), so the check reads the context, and staff is the session user, never CURRENT_USER.
-- Refusals are 23514 EFFECT_PROPOSAL_MISMATCH. Staff (a superuser or a member of the table owner's role as the
-- session user, the support and migration paths) are not checked; a definer's CURRENT_USER is never taken for staff.
--
-- What stays: a raw session of an eligible approver can approve through the gate (#1793) and then write the effect
-- in the same transaction; the row then names a proposal truly approved, by that identity, for that command (the
-- per-identity bound of #1793 and #1840). Requiring the approval to be of the same transaction would add nothing
-- against it, since the gate is callable there too.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.effect_proposal_is_executing(p_org uuid, p_proposal uuid, p_commands text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_org IS NOT NULL AND p_org = crove_kernel.ctx_org_id() AND EXISTS (
    SELECT 1 FROM crove_kernel.proposal p
    WHERE p.org_id = p_org AND p.id = p_proposal AND p.status = 'approved' AND p.command = ANY (p_commands))
$$;

CREATE OR REPLACE FUNCTION crove_finance.effect_proposal_staff(p_table oid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((
    SELECT r.rolsuper OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = p_table), 'USAGE')
    FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER), false)
$$;

CREATE OR REPLACE FUNCTION crove_finance.effect_proposal_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.proposal_id IS NULL OR crove_finance.effect_proposal_staff(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF NOT crove_finance.effect_proposal_is_executing(NEW.org_id, NEW.proposal_id, TG_ARGV::text[]) THEN
    RAISE EXCEPTION 'EFFECT_PROPOSAL_MISMATCH' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_NAME)::text;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION crove_finance.effect_proposal_entry_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.source_type IS DISTINCT FROM 'kernel.proposal' OR crove_finance.effect_proposal_staff(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF NEW.source_id IS NULL
     OR NOT crove_finance.effect_proposal_is_executing(NEW.org_id, NEW.source_id, ARRAY['finance.journal.reverse', 'finance.purchase.record']) THEN
    RAISE EXCEPTION 'EFFECT_PROPOSAL_MISMATCH' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('table', TG_TABLE_NAME)::text;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS effect_proposal ON crove_finance.purchase_document;
CREATE TRIGGER effect_proposal BEFORE INSERT ON crove_finance.purchase_document
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.purchase.record');
DROP TRIGGER IF EXISTS effect_proposal ON crove_finance.cash_voucher;
CREATE TRIGGER effect_proposal BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.voucher.record');
DROP TRIGGER IF EXISTS effect_proposal ON crove_finance.journal_voucher;
CREATE TRIGGER effect_proposal BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record');
DROP TRIGGER IF EXISTS effect_proposal ON crove_finance.journal_entry;
CREATE TRIGGER effect_proposal BEFORE INSERT ON crove_finance.journal_entry
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_entry_check();

-- EXECUTE matrix: the triggers run them as the writer; nobody calls them directly but through the tables.
REVOKE ALL ON FUNCTION crove_finance.effect_proposal_check(), crove_finance.effect_proposal_entry_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_finance.effect_proposal_is_executing(uuid, uuid, text[]), crove_finance.effect_proposal_staff(oid) FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.effect_proposal_is_executing(uuid, uuid, text[]), crove_finance.effect_proposal_staff(oid) TO crove_tenant, crove_definer_tenant;
