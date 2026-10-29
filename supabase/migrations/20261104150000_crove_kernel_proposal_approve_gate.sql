-- Crove kernel (issue #1793, the P13 residual of #1707; plan §4.7 P09, P10, P12 and §4.10): a user's session moves a
-- proposal from 'pending' to 'approved' only through the approval gate, which decides the approval in the database.
-- Idempotent; applied files stay untouched.
--
-- Until now proposal_status_guard (#1707) let any tenant writer move a pending proposal to 'approved' when it named an
-- executing command, so a session with raw SQL on the runtime's connection could mark a proposal approved without any
-- approval (nothing executed, but the proposal read as approved and #1695 accepted audit rows naming it). The runtime
-- decides P09, P10 and P12 (packages/kernel/src/approval.ts) before that update, and the database could not tell its
-- update from a forged one: the same login role, and any mark or definer the runtime used could be called directly.
--
-- crove_kernel.proposal_approve(p_proposal_id, p_revision, p_executed_command_id)   SECURITY DEFINER, EXECUTE for
--   crove_app alone (never crove_worker or PUBLIC): the only way a user's context moves a proposal to 'approved'. It decides the approval itself, from
--   the database alone, with the rules of decideApproval (approval.ts), and refuses when they say no:
--     - a user context of the proposal's org, which sees the proposal's legal entity (le_scope), on a pending proposal
--       of that revision (NOT_FOUND, PROPOSAL_DECIDED, STALE_REVISION);
--     - P12: the user is in the snapshot taken at creation and still holds an approving base role or the command's
--       approval permission through an org-wide assignment (a viewer holds none), under the org's preset now (P09: a
--       preset that reserves the ledger to the chief accountant leaves only the permission); the snapshot members'
--       rows are locked FOR SHARE in user_id order first, as approval.ts does (NOT_ELIGIBLE). The permission is written
--       as its literal key, as the manifest check reads it (#1641): a policy naming another permission makes nobody
--       eligible through it (fail closed), and the parity test fails until this follows;
--     - P10: an author approves only as the sole eligible approver (self_approved), or as an owner when every eligible
--       approver is an author (owner_override); never a ledger proposal under such a preset (FOUR_EYES_REQUIRED);
--     - authors and snapshot recorded and well formed, else NOT_ELIGIBLE (fail closed).
--   The decision is crove_kernel.proposal_approval_decide, no EXECUTE for any login role. Then it writes the approval
--   (who, when, the executing command) and returns the outcome the audit row records.
--   Refusals are 42501 with the code as the message. P11 (a fresh second factor) stays the runtime's: the database
--   never sees the token.
-- crove_kernel.approval_command_policy(command)   who may approve a proposal command: the approval.ts POLICIES table,
--   kept equal by apps/kernel/test/invariant/proposal-approve-gate.db.test.ts. Unknown commands: nobody.
-- proposal_status_guard   pending -> approved by a plain update only in the system context (the worker executing an
--   agent's approval, decided by decideAgentApproval); agent contexts write no proposal at all (agent_write_guard).
--   It also keeps what P10 and P12 stand on, so the gate cannot be fed forged inputs by the same session: outside the
--   system context a proposal's command and snapshot never change and its authors only grow (an edit adds its editor),
--   and a user's pending insert (kernel.proposal.request, resubmit) gets the snapshot of now
--   (crove_kernel.approval_eligible_now, the rule of approval.ts eligibleApprovers) and must name its writer among the
--   authors, and no other author but those of the proposal it asks for again; its snapshot is set by the guard itself.
--   A change of a proposal's content outside the system context is a new revision whose writer is among the authors,
--   and the authors grow only by the writer. Copied from 20261104070000_crove_kernel_proposal_status_guard.sql (the
--   newest definition) with those rules added.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.approval_command_policy(p_command text, OUT roles text[], OUT permission text, OUT four_eyes boolean, OUT ledger boolean)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH ledger AS (
    SELECT p_command IN ('finance.purchase.record', 'finance.journal.reverse', 'finance.voucher.record',
                         'finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record') AS is_ledger
  )
  SELECT CASE WHEN l.is_ledger THEN ARRAY['owner', 'admin']::text[] ELSE ARRAY[]::text[] END,
         CASE WHEN l.is_ledger THEN 'finance.proposal.approve' END,
         true,
         l.is_ledger
  FROM ledger l
$$;
REVOKE ALL ON FUNCTION crove_kernel.approval_command_policy(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The decision of decideApproval (approval.ts), in the database: whether p_user may approve a proposal of p_command in
-- p_org with this status, snapshot and authors. reason: ok, not_pending, not_eligible or four_eyes, with the outcome the
-- audit row records. p_lock: lock the snapshot members' rows FOR SHARE first, in user_id order (the approval does). A
-- definer, so it reads memberships and assignments whatever the caller's policies; only proposal_approve calls it, for
-- the org of the caller's sealed context (no EXECUTE for any login role). Kept equal to decideApproval by
-- apps/kernel/test/invariant/proposal-approve-gate.db.test.ts, case by case.
CREATE OR REPLACE FUNCTION crove_kernel.proposal_approval_decide(
  p_org uuid, p_command text, p_status text, p_snapshot uuid[], p_authors jsonb, p_user uuid, p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_policy record;
  v_roles text[];
  v_preset text;
  v_version integer;
  v_ledger_only boolean;
  -- The user authors' ids as written, compared as text the way approval.ts compares them (an id in capitals is not
  -- its lower-case user).
  v_authors text[];
  v_eligible uuid[];
  v_role text;
BEGIN
  SELECT t.approval_preset, t.approval_policy_version, ap.ledger_chief_accountant_only INTO v_preset, v_version, v_ledger_only
  FROM crove_kernel.tenant t JOIN crove_kernel.approval_preset ap ON ap.key = t.approval_preset
  WHERE t.org_id = p_org;
  -- No tenant row: read as the strictest preset (approval.ts orgApprovalPolicy).
  IF NOT FOUND THEN
    v_preset := 'accountant';
    v_version := 0;
    v_ledger_only := true;
  END IF;
  IF p_status IS DISTINCT FROM 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_pending', 'eligibleCount', 0, 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- A pending proposal without a recorded snapshot or well-formed authors (as parseAuthors) cannot be judged.
  IF p_user IS NULL OR pg_catalog.cardinality(coalesce(p_snapshot, ARRAY[]::uuid[])) = 0 OR p_authors IS NULL
     OR pg_catalog.jsonb_typeof(p_authors) <> 'array'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(p_authors) a
       -- IS NOT TRUE: a missing field makes the test NULL, which counts as malformed (zod's z.uuid() pattern, case as it).
       WHERE (pg_catalog.jsonb_typeof(a) = 'object' AND (
         (a ->> 'type' = 'user' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$')
         OR (a ->> 'type' = 'system' AND pg_catalog.jsonb_typeof(a -> 'component') = 'string')
         OR (a ->> 'type' = 'agent' AND pg_catalog.jsonb_typeof(a -> 'id') = 'string' AND a ->> 'id' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
             AND pg_catalog.jsonb_typeof(a -> 'run') = 'string' AND a ->> 'run' ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'))) IS NOT TRUE) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_eligible', 'eligibleCount', 0, 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- The preset in force now (P09): a preset that reserves the ledger to the chief accountant leaves only the permission.
  SELECT * INTO v_policy FROM crove_kernel.approval_command_policy(p_command);
  v_roles := CASE WHEN v_policy.ledger AND v_ledger_only THEN ARRAY[]::text[] ELSE v_policy.roles END;
  IF pg_catalog.cardinality(v_roles) = 0 AND v_policy.permission IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_eligible', 'eligibleCount', 0, 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- P12: the snapshot members still holding an approving base role or the permission org-wide (a viewer holds none),
  -- their rows locked first when asked.
  IF p_lock THEN
    PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org AND m.user_id = ANY (p_snapshot) ORDER BY m.user_id FOR SHARE;
  END IF;
  v_eligible := ARRAY(
    SELECT m.user_id FROM crove_kernel.tenant_member m
    WHERE m.org_id = p_org AND m.user_id = ANY (p_snapshot)
      AND (m.role = ANY (v_roles)
           OR (v_policy.permission = 'finance.proposal.approve' AND m.role <> 'viewer' AND EXISTS (
                 SELECT 1 FROM crove_kernel.role_assignment a JOIN crove_kernel.role_permission rp ON rp.role_key = a.role_key
                 WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL AND rp.permission = 'finance.proposal.approve')))
    ORDER BY m.user_id);
  IF NOT (p_user = ANY (v_eligible)) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'not_eligible', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  -- P10 (and P09 with it).
  v_authors := ARRAY(SELECT a ->> 'id' FROM pg_catalog.jsonb_array_elements(p_authors) a WHERE a ->> 'type' = 'user');
  IF NOT (p_user::text = ANY (v_authors)) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'ok', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  IF v_policy.ledger AND v_ledger_only THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'four_eyes', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
  END IF;
  IF NOT v_policy.four_eyes OR pg_catalog.cardinality(v_eligible) < 2 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'ok', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', true, 'fourEyes', 'self_approved', 'preset', v_preset, 'version', v_version);
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org AND m.user_id = p_user;
  IF v_role = 'owner' AND ARRAY(SELECT e::text FROM pg_catalog.unnest(v_eligible) e) <@ v_authors THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'ok', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', true, 'fourEyes', 'owner_override', 'preset', v_preset, 'version', v_version);
  END IF;
  RETURN pg_catalog.jsonb_build_object('reason', 'four_eyes', 'eligibleCount', pg_catalog.cardinality(v_eligible), 'selfApproved', false, 'fourEyes', 'pass', 'preset', v_preset, 'version', v_version);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.proposal_approval_decide(uuid, text, text, uuid[], jsonb, uuid, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Who may approve a proposal of p_command in p_org right now (approval.ts eligibleApprovers): members with an approving
-- base role under the org's preset, and members (not viewers) holding the command's approval permission org-wide, in
-- user_id order. A definer, for the org of the caller's sealed context only (another org answers nothing); EXECUTE for
-- crove_tenant, whose members read memberships anyway, because proposal_status_guard runs as the writer.
CREATE OR REPLACE FUNCTION crove_kernel.approval_eligible_now(p_org uuid, p_command text) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_policy record;
  v_roles text[];
  v_ledger_only boolean;
BEGIN
  IF p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  SELECT ap.ledger_chief_accountant_only INTO v_ledger_only
  FROM crove_kernel.tenant t JOIN crove_kernel.approval_preset ap ON ap.key = t.approval_preset
  WHERE t.org_id = p_org;
  v_ledger_only := coalesce(v_ledger_only, true);
  SELECT * INTO v_policy FROM crove_kernel.approval_command_policy(p_command);
  v_roles := CASE WHEN v_policy.ledger AND v_ledger_only THEN ARRAY[]::text[] ELSE v_policy.roles END;
  RETURN ARRAY(
    SELECT m.user_id FROM crove_kernel.tenant_member m
    WHERE m.org_id = p_org
      AND (m.role = ANY (v_roles)
           OR (v_policy.permission = 'finance.proposal.approve' AND m.role <> 'viewer' AND EXISTS (
                 SELECT 1 FROM crove_kernel.role_assignment a JOIN crove_kernel.role_permission rp ON rp.role_key = a.role_key
                 WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL AND rp.permission = 'finance.proposal.approve')))
    ORDER BY m.user_id);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.approval_eligible_now(uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.approval_eligible_now(uuid, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.proposal_approve(p_proposal_id uuid, p_revision integer, p_executed_command_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_scope text[] := crove_kernel.ctx_le_scope();
  v_p record;
  v_decision jsonb;
BEGIN
  -- Only a user's context, and the user only from it (never a parameter).
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL OR v_org IS NULL OR p_executed_command_id IS NULL THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  -- One of another org, none, or one of an entity outside the caller's scope: the same answer, and no lock on it.
  SELECT p.status, p.revision, p.command, p.eligible_approvers, p.authors INTO v_p
  FROM crove_kernel.proposal p
  WHERE p.org_id = v_org AND p.id = p_proposal_id
    AND coalesce('*' = ANY (v_scope) OR p.legal_entity_id::text = ANY (v_scope), false)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'PROPOSAL_DECIDED' USING ERRCODE = '42501';
  END IF;
  IF v_p.revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'STALE_REVISION' USING ERRCODE = '42501';
  END IF;
  v_decision := crove_kernel.proposal_approval_decide(v_org, v_p.command, v_p.status, v_p.eligible_approvers, v_p.authors, v_user, true);
  IF v_decision ->> 'reason' = 'four_eyes' THEN
    RAISE EXCEPTION 'FOUR_EYES_REQUIRED' USING ERRCODE = '42501';
  ELSIF v_decision ->> 'reason' <> 'ok' THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.proposal
  SET status = 'approved', decided_by = v_user, decided_at = pg_catalog.now(), executed_command_id = p_executed_command_id
  WHERE org_id = v_org AND id = p_proposal_id;
  RETURN v_decision - 'reason';
END $$;
-- The API's login role only: the worker approves nothing as a user (an agent's approval runs as the system).
REVOKE ALL ON FUNCTION crove_kernel.proposal_approve(uuid, integer, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.proposal_approve(uuid, integer, uuid) TO crove_app;

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
  -- A terminal proposal stays as it is, every column of it. org_id is left to the tenant policy, whose WITH CHECK
  -- refuses a move to another org (and the RLS matrix expects that refusal, not this one).
  IF OLD.status IN ('executed', 'rejected', 'failed', 'expired')
     AND pg_catalog.to_jsonb(NEW) - 'org_id' IS DISTINCT FROM pg_catalog.to_jsonb(OLD) - 'org_id' THEN
    RAISE EXCEPTION 'PROPOSAL_STATUS_TRANSITION' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('from', OLD.status, 'to', NEW.status, 'frozen', 'content')::text;
  END IF;
  RETURN NEW;
END $$;
