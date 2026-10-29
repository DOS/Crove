-- Crove kernel (issue #1842, option 3 of #1840): an approved ledger proposal moves to 'executed' only with its command's
-- effect posted in the same transaction. Idempotent; applied files stay untouched.
--
-- proposal_status_guard   approved -> executed needs, besides the ok audit row of the proposal's command written in this
--   transaction by this actor (#1816), crove_finance.ledger_effect_recorded (20261104230000): true for a command that is
--   not a ledger command, and for a ledger command only when a journal entry tied to the proposal through that command's
--   path was posted in this transaction. So a session with raw SQL on the runtime's connection that writes the audit row
--   itself can no longer mark a money-path proposal executed with nothing posted. Copied from
--   20261104170000_crove_kernel_proposal_executed_gate.sql (the newest definition) with that rule added.
-- The kernel names a finance function here because the ledger commands are finance's (approval_command_policy names them
-- too); the guard reaches it only on approved -> executed, as the writer, which has EXECUTE on it.
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
    IF NEW.status IN ('approved', 'executed')
       OR pg_catalog.num_nonnulls(NEW.executed_command_id, NEW.decided_by, NEW.decided_by_agent, NEW.decided_at, NEW.result) > 0 THEN
      RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('to', NEW.status)::text;
    END IF;
    -- A user's pending proposal (kernel.proposal.request, resubmit) names its writer among the authors, and no other
    -- author but those of the proposal it asks for again; its snapshot is the database's own, taken here in the same
    -- statement (#1793), so the gate's P10 and P12 stand on what the database itself records.
    IF NEW.status = 'pending' AND crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'user' THEN
      IF NOT coalesce(NEW.authors @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'user', 'id', crove_kernel.ctx_user_id())), false)
         OR EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_array_elements(NEW.authors) e
           WHERE e IS DISTINCT FROM pg_catalog.jsonb_build_object('type', 'user', 'id', crove_kernel.ctx_user_id())
             AND NOT EXISTS (
               SELECT 1 FROM crove_kernel.proposal r
               WHERE NEW.resubmitted_from IS NOT NULL AND r.org_id = NEW.org_id AND r.id = NEW.resubmitted_from
                 AND r.authors @> pg_catalog.jsonb_build_array(e))) THEN
        RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
          DETAIL = pg_catalog.json_build_object('to', NEW.status, 'frozen', 'policy')::text;
      END IF;
      NEW.eligible_approvers := crove_kernel.approval_eligible_now(NEW.org_id, NEW.command);
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

  -- What P10 and P12 stand on (#1793): outside the system context (the worker reads files and records agents'
  -- proposals), a proposal's command and snapshot do not change; its authors only grow, and only by the writer; and a
  -- change of its content is a new revision whose writer is among the authors (as kernel.proposal.edit makes it), so
  -- nobody approves content they wrote while not counted as its author.
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     AND ((NEW.command, NEW.eligible_approvers) IS DISTINCT FROM (OLD.command, OLD.eligible_approvers)
          OR (OLD.authors IS NOT NULL AND NOT coalesce(NEW.authors @> OLD.authors, false))
          OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(NEW.authors) = 'array' THEN NEW.authors ELSE '[]'::jsonb END) e
            WHERE NOT coalesce(OLD.authors @> pg_catalog.jsonb_build_array(e), false) AND e IS DISTINCT FROM pg_catalog.jsonb_build_object('type', 'user', 'id', crove_kernel.ctx_user_id()))
          OR ((NEW.payload, NEW.title, NEW.request_input, NEW.duplicate_of, NEW.revision)
                IS DISTINCT FROM (OLD.payload, OLD.title, OLD.request_input, OLD.duplicate_of, OLD.revision)
              AND NOT (NEW.revision > OLD.revision AND coalesce(NEW.authors @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'user', 'id', crove_kernel.ctx_user_id())), false)))) THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'to', NEW.status, 'frozen', 'policy')::text;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'frozen', 'id')::text;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := CASE
      -- Only the worker's system context (an agent's approval, kernel.agent.proposal.approve) moves it itself; a user's
      -- approval goes through crove_kernel.proposal_approve, a definer this guard does not check (#1793).
      WHEN OLD.status = 'pending' AND NEW.status = 'approved' THEN
        NEW.executed_command_id IS NOT NULL AND crove_kernel.ctx_actor_type() IS NOT DISTINCT FROM 'system'
      WHEN OLD.status = 'pending' AND NEW.status = 'rejected' THEN
        NEW.decided_by IS NOT NULL AND NEW.decided_at IS NOT NULL
      WHEN OLD.status = 'pending' AND NEW.status = 'expired' THEN
        NEW.decided_at IS NOT NULL
      -- The proposal's command ran in this transaction, for this proposal, as this actor: the runtime writes its ok row
      -- before the execution marks the proposal executed (#1816).
      -- For a ledger command, its effect too: a journal entry for this proposal, posted in this transaction (#1842).
      WHEN OLD.status = 'approved' AND NEW.status = 'executed' THEN
        crove_kernel.proposal_execution_recorded(NEW.org_id, NEW.id, OLD.command)
        AND crove_finance.ledger_effect_recorded(NEW.org_id, NEW.id, OLD.command)
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
  -- A terminal proposal stays as it is, every column of it. org_id is left to the tenant policy, whose WITH CHECK
  -- refuses a move to another org (and the RLS matrix expects that refusal, not this one).
  IF OLD.status IN ('executed', 'rejected', 'failed', 'expired')
     AND pg_catalog.to_jsonb(NEW) - 'org_id' IS DISTINCT FROM pg_catalog.to_jsonb(OLD) - 'org_id' THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'to', NEW.status, 'frozen', 'content')::text;
  END IF;
  RETURN NEW;
END $$;
