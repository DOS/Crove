-- Crove kernel (issue #1695, plan §4.10 "approvals carry proposal_id, which nothing checks"): an audit row that names a
-- proposal names one of its own org, in a state the runtime writes such a row in. Until now a session could write a row
-- naming any id as its proposal_id: another org's proposal, one that does not exist, or one long executed or rejected,
-- so a row could claim an approval that never ran. Idempotent; applied files stay untouched.
--
-- audit_event_proposal (BEFORE INSERT, a row with a proposal_id; coordinator decision on #1695, option A):
--   - the row is for the org of the session's sealed context, checked before the proposal is read, so a row aimed at
--     another org answers the same refusal whatever that org holds (RLS refuses such a row anyway, but only after this
--     trigger, and a different error would tell which of its proposals exist);
--   - the proposal is the row's own org's (another org's id is refused like an id that does not exist);
--   - a row for the proposal's own command (the command it executes) needs the proposal 'approved'. The runtime never
--     commits that state: kernel.proposal.approve (and an agent's approval) sets it, runs the command and ends
--     'executed' in the same transaction, or rolls back to 'pending'. The check reads the proposal as the session's own
--     transaction sees it, so it binds a row to a proposal that transaction approved; a session that may update
--     proposals could still move one there itself (a status transition guard is #1707). When the
--     system executes approved proposals later (plan §4.7, P13), 'approved' may commit and this check is revisited;
--   - a row for any other command needs the proposal 'approved' (a command the execution runs, such as
--     kernel.party.link_for_tax_code under finance.purchase.record) or 'pending' (the reviser kernel.proposal.edit runs);
--   - a row naming an executed, rejected, failed or expired proposal is refused, whatever its command.
-- The runtime passes a command's proposal id on to the commands it runs (ctx.run), and each writes its own row, so the
-- database cannot ask for the proposal's own command on every row without refusing those flows. Left open: a row under
-- another command name naming a pending proposal of its own org (option B, #1706).
-- Staff (a superuser, or a role that can act as the table's owner) are not checked, as audit_event_stamp, so a support
-- fix or a test that builds history is not changed. A definer, so the check reads the proposal whatever the caller's
-- policies let it see, always within the row's own org.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.audit_event_proposal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_status text;
  v_command text;
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
  SELECT p.status, p.command INTO v_status, v_command
  FROM crove_kernel.proposal p
  WHERE p.org_id = NEW.org_id AND p.id = NEW.proposal_id;
  IF NOT FOUND
     OR v_status NOT IN ('approved', 'pending')
     OR (NEW.command = v_command AND v_status <> 'approved') THEN
    RAISE EXCEPTION 'AUDIT_PROPOSAL_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
-- A hot table: the trigger is created in the lock-retry block (plan §5.5). It fires by name after agent_write_guard and
-- before audit_event_stamp; neither changes org_id, command or proposal_id, and a BEFORE trigger sorting after this one
-- must not either.
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    CREATE OR REPLACE TRIGGER audit_event_proposal BEFORE INSERT ON crove_kernel.audit_event
      FOR EACH ROW WHEN (NEW.proposal_id IS NOT NULL) EXECUTE FUNCTION crove_kernel.audit_event_proposal();
    EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;

-- EXECUTE matrix: the trigger's function is callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.audit_event_proposal() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
