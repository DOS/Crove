-- Crove kernel (issue #1707, from the review of #1695; plan §4.10): a proposal's status moves only the way the runtime
-- moves it, so a session cannot reopen a decided proposal or skip its approval. Idempotent; applied files stay
-- untouched.
--
-- crove_tenant may UPDATE crove_kernel.proposal under the tenant policy, and until now nothing limited its status. A
-- session with an entered context could move an executed, rejected or expired proposal back to 'approved', write an
-- audit row under the proposal's own command (which audit_event_proposal, #1695, accepts for an 'approved' proposal),
-- and move the status back; or move a pending proposal to 'approved' and on to 'executed' without any approval.
--
-- proposal_status_guard (BEFORE INSERT OR UPDATE OR DELETE, ENABLE ALWAYS). On UPDATE it allows exactly the transitions
-- the runtime makes:
--     pending  -> approved   kernel.proposal.approve (and approve_many through it), an agent's approval
--                            (kernel.agent.proposal.approve): it names the command that runs it (executed_command_id)
--     pending  -> rejected   kernel.proposal.reject: it names who decided and when
--     pending  -> expired    kernel.proposal.expire: it names when
--     approved -> executed   the same approval, in the same transaction, after the command ran
-- and an update that keeps the status. Every other change of status is refused with PROPOSAL_STATUS_TRANSITION
-- (23514): out of a terminal state (executed, rejected, failed, expired), back from 'approved' (the runtime rolls the
-- transaction back instead), and 'pending' straight to 'executed'. A decided proposal's record is frozen too: once
-- 'approved', who decided, when and the executing command do not change; in a terminal state neither does its content
-- (payload, revision), its decision note or its result, and no proposal's id changes. Other columns (reminded_at,
-- escalated_at) stay writable as before.
-- So that a decided proposal cannot be rebuilt either: an INSERT may not write one 'approved' or 'executed', or naming
-- an executing command (the runtime inserts 'pending' only; a 'rejected', 'failed' or 'expired' row decides nothing an
-- audit row could lean on, and the RLS matrix's factory writes one), and a DELETE may not remove a proposal that is no
-- longer 'pending' (no tenant code deletes proposals; the org purge, a definer run as the table's owner, still does).
--
-- What it does not do: tie the move to 'approved' to a real approval. A session that may update proposals can still
-- approve a pending proposal itself and mark it executed on paper (no command runs). Requiring decided_by on that move
-- would not stop it (the session names itself) and would change the #1695 invariant, whose own test approves that way. The P10 and P12
-- checks live in the runtime (packages/kernel/src/approval.ts); binding the move to them belongs with the system
-- execution of approved proposals (plan §4.7, P13). Agents write no proposal at all (agent_write_guard fires first, by
-- name).
--
-- Staff (a session user that is a superuser or can act as the table's owner: the migration runner) are not checked, as
-- in audit_event_proposal (20261103100000), so a support fix or a test that builds history is not changed; nor is a
-- definer owned by the table's owner (the current user can act as the owner: the org purge). An invoker: it reads only
-- the row and the session's roles.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.proposal_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_allowed boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
         OR pg_catalog.pg_has_role(CURRENT_USER, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('approved', 'executed') OR NEW.executed_command_id IS NOT NULL THEN
      RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('to', NEW.status)::text;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('from', OLD.status, 'deleted', true)::text;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'frozen', 'id')::text;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := CASE
      WHEN OLD.status = 'pending' AND NEW.status = 'approved' THEN NEW.executed_command_id IS NOT NULL
      WHEN OLD.status = 'pending' AND NEW.status = 'rejected' THEN
        NEW.decided_by IS NOT NULL AND NEW.decided_at IS NOT NULL
      WHEN OLD.status = 'pending' AND NEW.status = 'expired' THEN
        NEW.decided_at IS NOT NULL
      WHEN OLD.status = 'approved' AND NEW.status = 'executed' THEN true
      ELSE false
    END;
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('from', OLD.status, 'to', NEW.status)::text;
    END IF;
  END IF;

  -- The decision of an approved or decided proposal stays as it was made.
  IF OLD.status <> 'pending'
     AND (NEW.decided_by, NEW.decided_by_agent, NEW.decided_at, NEW.executed_command_id)
         IS DISTINCT FROM (OLD.decided_by, OLD.decided_by_agent, OLD.decided_at, OLD.executed_command_id) THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'to', NEW.status, 'frozen', 'decision')::text;
  END IF;
  -- A terminal proposal's content and outcome stay too.
  IF OLD.status IN ('executed', 'rejected', 'failed', 'expired')
     AND (NEW.payload, NEW.revision, NEW.decision_note, NEW.result)
         IS DISTINCT FROM (OLD.payload, OLD.revision, OLD.decision_note, OLD.result) THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'to', NEW.status, 'frozen', 'content')::text;
  END IF;
  RETURN NEW;
END $$;
-- A trigger function only; nobody calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.proposal_status_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- It fires by name after agent_write_guard (an agent's write is refused there first), b_legal_entity,
-- proposal_before_insert and proposal_keep_provenance; none of them changes id, status or a decision column.
DROP TRIGGER IF EXISTS proposal_status_guard ON crove_kernel.proposal;
CREATE TRIGGER proposal_status_guard BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.proposal
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_status_guard();
-- Also in replica mode, where ordinary triggers stay silent.
ALTER TABLE crove_kernel.proposal ENABLE ALWAYS TRIGGER proposal_status_guard;
