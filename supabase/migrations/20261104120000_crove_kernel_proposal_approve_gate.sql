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
--   crove_tenant: the only way a user's context moves a proposal to 'approved'. It decides the approval itself, from
--   the database alone, with the rules of decideApproval (approval.ts), and refuses when they say no:
--     - a user context of the proposal's org, which sees the proposal's legal entity (le_scope), on a pending proposal
--       of that revision (NOT_FOUND, PROPOSAL_DECIDED, STALE_REVISION);
--     - P12: the user is in the snapshot taken at creation and still holds an approving base role or the command's
--       approval permission through an org-wide assignment (a viewer holds none), under the org's preset now (P09: a
--       preset that reserves the ledger to the chief accountant leaves only the permission); the snapshot members'
--       rows are locked FOR SHARE in user_id order first, as approval.ts does (NOT_ELIGIBLE);
--     - P10: an author approves only as the sole eligible approver (self_approved), or as an owner when every eligible
--       approver is an author (owner_override); never a ledger proposal under such a preset (FOUR_EYES_REQUIRED);
--     - authors and snapshot recorded and well formed, else NOT_ELIGIBLE (fail closed).
--   Then it writes the approval (who, when, the executing command) and returns the outcome the audit row records.
--   Refusals are 42501 with the code as the message. P11 (a fresh second factor) stays the runtime's: the database
--   never sees the token.
-- crove_kernel.approval_command_policy(command)   who may approve a proposal command: the approval.ts POLICIES table,
--   kept equal by apps/kernel/test/proposal-approve-gate.db.test.ts. Unknown commands: nobody.
-- proposal_status_guard   pending -> approved by a plain update only in the system context (the worker executing an
--   agent's approval, decided by decideAgentApproval); agent contexts write no proposal at all (agent_write_guard).
--   Copied from 20261104070000_crove_kernel_proposal_status_guard.sql (the newest definition) with only that rule
--   changed.
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

CREATE OR REPLACE FUNCTION crove_kernel.proposal_approve(p_proposal_id uuid, p_revision integer, p_executed_command_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_scope text[] := crove_kernel.ctx_le_scope();
  v_p record;
  v_policy record;
  v_roles text[];
  v_preset text;
  v_version integer;
  v_ledger_only boolean;
  v_snapshot uuid[];
  v_authors uuid[];
  v_eligible uuid[];
  v_role text;
  v_outcome text;
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL OR v_org IS NULL OR p_executed_command_id IS NULL THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  SELECT p.status, p.revision, p.command, p.eligible_approvers, p.authors, p.legal_entity_id INTO v_p
  FROM crove_kernel.proposal p
  WHERE p.org_id = v_org AND p.id = p_proposal_id
  FOR UPDATE;
  -- One of another org, none, or one of an entity outside the caller's scope: the same answer.
  IF NOT FOUND OR NOT ('*' = ANY (v_scope) OR v_p.legal_entity_id::text = ANY (v_scope)) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  IF v_p.status <> 'pending' THEN
    RAISE EXCEPTION 'PROPOSAL_DECIDED' USING ERRCODE = '42501';
  END IF;
  IF v_p.revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION 'STALE_REVISION' USING ERRCODE = '42501';
  END IF;

  -- The org's preset now; no tenant row reads as the strictest one.
  SELECT t.approval_preset, t.approval_policy_version, ap.ledger_chief_accountant_only INTO v_preset, v_version, v_ledger_only
  FROM crove_kernel.tenant t JOIN crove_kernel.approval_preset ap ON ap.key = t.approval_preset
  WHERE t.org_id = v_org;
  IF NOT FOUND THEN
    v_preset := 'accountant';
    v_version := 0;
    v_ledger_only := true;
  END IF;
  SELECT * INTO v_policy FROM crove_kernel.approval_command_policy(v_p.command);
  v_roles := CASE WHEN v_policy.ledger AND v_ledger_only THEN ARRAY[]::text[] ELSE v_policy.roles END;
  IF pg_catalog.cardinality(v_roles) = 0 AND v_policy.permission IS NULL THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;

  -- The snapshot and the authors, recorded and well formed (as parseAuthors), else fail closed.
  v_snapshot := coalesce(v_p.eligible_approvers, ARRAY[]::uuid[]);
  IF pg_catalog.cardinality(v_snapshot) = 0 OR v_p.authors IS NULL OR pg_catalog.jsonb_typeof(v_p.authors) <> 'array'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_p.authors) a
       WHERE NOT (pg_catalog.jsonb_typeof(a) = 'object' AND (
         (a ->> 'type' = 'user' AND a ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
         OR (a ->> 'type' = 'system' AND pg_catalog.jsonb_typeof(a -> 'component') = 'string')
         OR (a ->> 'type' = 'agent' AND a ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND a ->> 'run' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))) THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;
  v_authors := ARRAY(SELECT (a ->> 'id')::uuid FROM pg_catalog.jsonb_array_elements(v_p.authors) a WHERE a ->> 'type' = 'user');

  -- P12: the snapshot members' rows locked first, in user_id order (as membership changes lock them), then who still
  -- holds an approving base role or the approval permission org-wide.
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = ANY (v_snapshot) ORDER BY m.user_id FOR SHARE;
  v_eligible := ARRAY(
    SELECT m.user_id FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ANY (v_snapshot)
      AND (m.role = ANY (v_roles)
           OR (v_policy.permission IS NOT NULL AND m.role <> 'viewer' AND EXISTS (
                 SELECT 1 FROM crove_kernel.role_assignment a JOIN crove_kernel.role_permission rp ON rp.role_key = a.role_key
                 WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL AND rp.permission = v_policy.permission)))
    ORDER BY m.user_id);
  IF NOT (v_user = ANY (v_eligible)) THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE' USING ERRCODE = '42501';
  END IF;

  -- P10 (and P09 with it).
  IF NOT (v_user = ANY (v_authors)) THEN
    v_outcome := 'pass';
  ELSIF v_policy.ledger AND v_ledger_only THEN
    RAISE EXCEPTION 'FOUR_EYES_REQUIRED' USING ERRCODE = '42501';
  ELSIF NOT v_policy.four_eyes OR pg_catalog.cardinality(v_eligible) < 2 THEN
    v_outcome := 'self_approved';
  ELSE
    SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user;
    IF v_role = 'owner' AND v_eligible <@ v_authors THEN
      v_outcome := 'owner_override';
    ELSE
      RAISE EXCEPTION 'FOUR_EYES_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE crove_kernel.proposal
  SET status = 'approved', decided_by = v_user, decided_at = pg_catalog.now(), executed_command_id = p_executed_command_id
  WHERE org_id = v_org AND id = p_proposal_id;
  RETURN pg_catalog.jsonb_build_object(
    'fourEyes', v_outcome, 'selfApproved', v_outcome <> 'pass', 'eligibleCount', pg_catalog.cardinality(v_eligible),
    'preset', v_preset, 'version', v_version);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.proposal_approve(uuid, integer, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.proposal_approve(uuid, integer, uuid) TO crove_tenant;

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
