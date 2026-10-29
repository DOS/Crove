-- Crove kernel (issue #1816, from the review of #1802; plan §4.7 and §4.10): an approved proposal moves to 'executed'
-- only when its command ran. Idempotent; applied files stay untouched.
--
-- Since #1793 a user's session reaches 'approved' only through the database's gate (crove_kernel.proposal_approve), but
-- proposal_status_guard let any tenant writer then move the approved proposal to 'executed' by a plain update, so a
-- session with raw SQL on the runtime's connection could mark it executed without running the proposal's command (the
-- proposal then read as done, with a result of its choosing and no effect).
--
-- crove_kernel.proposal_execution_recorded(org, proposal, command)   whether the ok audit row of the proposal's own
--   command, naming the proposal, was written in this transaction by the context's own actor (audit_event_stamp,
--   #1482, sets occurred_at to the transaction's now() and the actor from the sealed context on every tenant
--   insert; the check reads both back). The runtime writes that row when the command's
--   handler returns, inside the execution's transaction, before kernel.proposal.approve or the worker's
--   kernel.agent.proposal.approve marks the proposal executed. A definer for the org of the caller's sealed context
--   only (another org answers false), EXECUTE for crove_tenant because proposal_status_guard runs as the writer; it
--   answers a yes or no about rows the context's own actor wrote in its own transaction.
-- proposal_status_guard   approved -> executed needs that row, for every tenant writer (the system context included:
--   the worker's agent execution writes it too). Copied from 20261104150000_crove_kernel_proposal_approve_gate.sql
--   (the newest definition) with that rule added.
--
-- What stays: the audit row is the evidence, and a session with raw SQL can still insert one (#1695 accepts an ok row
-- of the proposal's own command while it is approved). That row is then the session's own, append-only and archived
-- in the WORM stream (#891) under its actor, so marking a proposal executed without running it now leaves a permanent,
-- attributable record of a command that claims to have run. The row is not tied to the executing command, the
-- revision or the payload (its input hash is not compared). The worker's system context, trusted to approve an agent's
-- proposal (#1793), can still approve and mark executed alone with such a row.

CREATE OR REPLACE FUNCTION crove_kernel.proposal_execution_recorded(p_org uuid, p_proposal uuid, p_command text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
BEGIN
  IF p_org IS DISTINCT FROM crove_kernel.ctx_org_id() OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = p_org
      AND a.occurred_at = pg_catalog.now()
      AND a.proposal_id = p_proposal
      AND a.command = p_command
      AND a.outcome = 'ok'
      AND a.actor_type = v_actor
      AND a.actor_id IS NOT DISTINCT FROM CASE WHEN v_actor = 'user' THEN crove_kernel.ctx_user_id() END);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.proposal_execution_recorded(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.proposal_execution_recorded(uuid, uuid, text) TO crove_tenant;

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
      WHEN OLD.status = 'approved' AND NEW.status = 'executed' THEN
        crove_kernel.proposal_execution_recorded(NEW.org_id, NEW.id, OLD.command)
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
