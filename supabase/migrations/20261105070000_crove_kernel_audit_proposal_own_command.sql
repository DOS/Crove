-- Crove kernel (issue #1706, option B of #1695; plan §4.10): only the row of a proposal's own command names the
-- proposal in audit_event.proposal_id, so a row naming a pending proposal is refused whatever its command.
-- Idempotent; applied files stay untouched.
--
-- Until now (20261103100000_crove_kernel_audit_proposal.sql, option A) a row for another command could name a pending or
-- approved proposal of its own org, because the runtime passed a proposal's id on to every command its edit or its
-- execution runs and each wrote its own row with it (the reviser finance.purchase.revise while pending,
-- kernel.party.link_for_tax_code under finance.purchase.record while approved). So a session could write a row under
-- another command name naming a pending proposal. The runtime now names the proposal in proposal_id only on the row of
-- the command the proposal gate admitted (access 'proposal'), and every other command run under it names it in
-- detail.under_proposal (packages/kernel-runtime/src/runtime.ts, writeAudit; ctx.audit facts cannot set that key).
--
-- audit_event_proposal (BEFORE INSERT, a row with a proposal_id or a detail.under_proposal):
--   - the row is for the org of the session's sealed context, checked before any proposal is read, so a row aimed at
--     another org answers the same refusal whatever that org holds (unchanged);
--   - proposal_id: the proposal is the row's own org's, the row is for the proposal's own command, and the proposal is
--     'approved' (the state only the approving transaction sees; the runtime never commits it);
--   - detail.under_proposal: a uuid naming a proposal of the row's own org that is 'pending' (an edit's reviser) or
--     'approved' (a command the execution runs), the rule option A had for another command's proposal_id; anything else
--     (not a uuid, another org's or no proposal, a decided one) is refused.
-- proposal_execution_recorded (#1816) reads the ok row of the proposal's own command naming it in proposal_id, which
-- the runtime still writes, so the move to 'executed' is unchanged. kernel.audit.list and the proposal timeline read
-- both links. Staff (a superuser, or a role that can act as the table's owner) are not checked, as before.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.audit_event_proposal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_status text;
  v_command text;
  v_link text;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  IF (crove_kernel.ctx_verified() ->> 'org')::uuid IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'AUDIT_PROPOSAL_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NEW.proposal_id IS NOT NULL THEN
    SELECT p.status, p.command INTO v_status, v_command
    FROM crove_kernel.proposal p
    WHERE p.org_id = NEW.org_id AND p.id = NEW.proposal_id;
    IF NOT FOUND OR NEW.command IS DISTINCT FROM v_command OR v_status <> 'approved' THEN
      RAISE EXCEPTION 'AUDIT_PROPOSAL_MISMATCH' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.detail) = 'object' AND NEW.detail ? 'under_proposal' THEN
    v_link := NEW.detail ->> 'under_proposal';
    IF v_link IS NULL OR v_link !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'AUDIT_PROPOSAL_MISMATCH' USING ERRCODE = '42501';
    END IF;
    SELECT p.status INTO v_status
    FROM crove_kernel.proposal p
    WHERE p.org_id = NEW.org_id AND p.id = v_link::uuid;
    IF NOT FOUND OR v_status NOT IN ('approved', 'pending') THEN
      RAISE EXCEPTION 'AUDIT_PROPOSAL_MISMATCH' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- A hot table: the trigger is created in the lock-retry block (plan §5.5). It fires by name after agent_write_guard and
-- before audit_event_stamp; neither changes org_id, command, proposal_id or detail, and a BEFORE trigger sorting after
-- this one must not either. It now fires for a row with either link.
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    CREATE OR REPLACE TRIGGER audit_event_proposal BEFORE INSERT ON crove_kernel.audit_event
      FOR EACH ROW WHEN (NEW.proposal_id IS NOT NULL OR (pg_catalog.jsonb_typeof(NEW.detail) = 'object' AND NEW.detail ? 'under_proposal'))
      EXECUTE FUNCTION crove_kernel.audit_event_proposal();
    EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;

-- EXECUTE matrix: the trigger's function is callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.audit_event_proposal() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
