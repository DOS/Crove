-- ADR-0029 Phase 1 follow-ups (issue #244): taint both ways between runs and tasks, database checks on agent
-- delegations and escalations, more tables agents may never write, activity rows that name the agent, and a sweep
-- that skips agents which cannot run. Idempotent; applied files stay untouched.
--
-- 1. Taint. An untainted run that claims a tainted task becomes tainted (ai_run.tainted, read by the next context
--    entry). A tainted run taints every task it writes: an update in its context, or a comment on the task.
-- 3. Defense in depth. In an agent context a new task is a delegation into the agent's own subtree, or an escalation
--    to the nearest active position up the chart held by a human (NULL: the owners), never anything else. Agent
--    contexts never write the tenant, its members, invites, proposals (approvals live there), or the finance rows only
--    humans confirm (the ledger, vendor account rules).
-- 7. agent_wakeups_due returns only agents that can start a run now: an active position of the template's role key, no
--    kill switch, the daily run cap not reached, no spent hard-stop budget, and (when the worker passes the enabled
--    modules) a template whose module is enabled.
-- 8. activity.agent_id: the agent whose context wrote the row, stamped from the sealed context.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Runs: an agent context may only mark its own run tainted
-- ---------------------------------------------------------------------------
-- Replaces refuse_agent_write on ai_run. The one write allowed in an agent context is the monotonic taint of the
-- context's own run (false to true, every other column unchanged), which task_before_update makes when the run claims
-- a tainted task. It only ever restricts the run further.
CREATE OR REPLACE FUNCTION crove_kernel.ai_run_refuse_agent_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() = 'agent' THEN
    IF TG_OP = 'UPDATE' AND OLD.org_id = crove_kernel.ctx_org_id() AND OLD.id = crove_kernel.ctx_run_id()
       AND NOT OLD.tainted AND NEW.tainted
       AND (pg_catalog.to_jsonb(NEW) - 'tainted') = (pg_catalog.to_jsonb(OLD) - 'tainted') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS refuse_agent_write ON crove_kernel.ai_run;
CREATE TRIGGER refuse_agent_write BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.ai_run
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.ai_run_refuse_agent_write();

-- ---------------------------------------------------------------------------
-- More tables agents never write (refuse_agent_write from 20261018050000)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crove_kernel.tenant', 'crove_kernel.tenant_member', 'crove_kernel.member_invite', 'crove_kernel.proposal',
    'crove_finance.journal_entry', 'crove_finance.journal_line', 'crove_finance.vendor_account_rule'] LOOP
    IF pg_catalog.to_regclass(t) IS NOT NULL THEN
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS refuse_agent_write ON %s', t);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER refuse_agent_write BEFORE INSERT OR UPDATE OR DELETE ON %s '
        'FOR EACH ROW EXECUTE FUNCTION crove_kernel.refuse_agent_write()', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Where an agent may send work (the same rules as kernel.task.delegate and kernel.task.escalate)
-- ---------------------------------------------------------------------------
-- The nearest active position up the chart from p_position held by a human, or NULL (the owners at the root).
CREATE OR REPLACE FUNCTION crove_kernel.task_escalation_target(p_org_id uuid, p_position uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE up (id, depth) AS (
    SELECT p.reports_to, 1 FROM crove_kernel.position p
    WHERE p.org_id = p_org_id AND p.id = p_position AND p.reports_to IS NOT NULL
    UNION ALL
    SELECT p.reports_to, up.depth + 1 FROM up JOIN crove_kernel.position p ON p.org_id = p_org_id AND p.id = up.id
    WHERE p.reports_to IS NOT NULL AND up.depth < 100
  )
  SELECT p.id FROM up JOIN crove_kernel.position p ON p.org_id = p_org_id AND p.id = up.id
  WHERE p.status = 'active' AND p.holder_user_id IS NOT NULL
  ORDER BY up.depth
  LIMIT 1
$$;

-- TRUE when p_candidate reports, directly or not, to p_root (a strict descendant).
CREATE OR REPLACE FUNCTION crove_kernel.position_in_subtree(p_org_id uuid, p_root uuid, p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE up (id, depth) AS (
    SELECT p.reports_to, 1 FROM crove_kernel.position p WHERE p.org_id = p_org_id AND p.id = p_candidate
    UNION ALL
    SELECT p.reports_to, up.depth + 1 FROM up JOIN crove_kernel.position p ON p.org_id = p_org_id AND p.id = up.id
    WHERE up.id IS NOT NULL AND up.depth < 100
  )
  SELECT p_candidate IS DISTINCT FROM p_root AND EXISTS (SELECT 1 FROM up WHERE up.id = p_root)
$$;

-- ---------------------------------------------------------------------------
-- Task rules every writer meets (replaces the 20261018050000 bodies)
-- ---------------------------------------------------------------------------
-- On insert: as before, plus, in an agent context, the kind and the assignee: a delegation goes to a position in the
-- agent's own subtree, an escalation to the escalation target of its position; agents create no other task.
CREATE OR REPLACE FUNCTION crove_kernel.task_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_found boolean := false;
  v_depth int;
  v_tainted boolean;
  v_run uuid;
  v_lock timestamptz;
  v_position uuid;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT t.request_depth, t.tainted, t.checkout_run_id, t.lock_expires_at INTO v_depth, v_tainted, v_run, v_lock
    FROM crove_kernel.task t WHERE t.org_id = NEW.org_id AND t.id = NEW.parent_task_id;
    v_found := FOUND;
    IF v_found THEN
      NEW.request_depth := v_depth + 1;
      NEW.tainted := NEW.tainted OR v_tainted;
    END IF;
  END IF;
  IF v_ctx IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.created_by_type := v_ctx ->> 'actor';
  NEW.created_by_id := CASE v_ctx ->> 'actor' WHEN 'user' THEN (v_ctx ->> 'user')::uuid WHEN 'agent' THEN (v_ctx ->> 'agent')::uuid END;
  NEW.created_by_run := (v_ctx ->> 'run')::uuid;
  IF v_ctx ->> 'actor' = 'agent' THEN
    NEW.tainted := NEW.tainted OR coalesce((v_ctx ->> 'tainted')::boolean, true);
    IF NOT v_found OR v_run IS DISTINCT FROM (v_ctx ->> 'run')::uuid OR v_lock IS NULL OR v_lock <= pg_catalog.now() THEN
      RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
    END IF;
    v_position := (v_ctx ->> 'position')::uuid;
    IF NEW.kind = 'delegation' THEN
      IF NEW.assignee_position_id IS NULL OR v_position IS NULL
         OR NOT crove_kernel.position_in_subtree(NEW.org_id, v_position, NEW.assignee_position_id) THEN
        RAISE EXCEPTION 'AGENT_DELEGATION_SUBTREE' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.kind = 'escalation' THEN
      IF v_position IS NULL OR NEW.assignee_position_id IS DISTINCT FROM crove_kernel.task_escalation_target(NEW.org_id, v_position) THEN
        RAISE EXCEPTION 'AGENT_ESCALATION_TARGET' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'AGENT_TASK_KIND' USING ERRCODE = '42501';
    END IF;
    NEW.checkout_run_id := NULL;
    NEW.lock_expires_at := NULL;
    NEW.fence := 0;
  END IF;
  RETURN NEW;
END $$;

-- On update in an agent context: as before, plus taint both ways. A tainted run's write taints the task; an untainted
-- run that claims a tainted task becomes tainted from its next context entry. An agent never clears a task's taint.
CREATE OR REPLACE FUNCTION crove_kernel.task_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_run uuid;
  v_run_expires timestamptz;
  v_ctx_tainted boolean;
BEGIN
  NEW.updated_at := pg_catalog.now();
  IF v_ctx IS NULL OR v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    RETURN NEW;
  END IF;
  v_run := (v_ctx ->> 'run')::uuid;
  v_ctx_tainted := coalesce((v_ctx ->> 'tainted')::boolean, true);
  IF (NEW.org_id, NEW.id, NEW.title, NEW.description, NEW.kind, NEW.assignee_position_id, NEW.parent_task_id, NEW.source,
      NEW.source_ref, NEW.source_event_id, NEW.created_by_type, NEW.created_by_id, NEW.created_by_run, NEW.due,
      NEW.request_depth, NEW.created_at)
     IS DISTINCT FROM
     (OLD.org_id, OLD.id, OLD.title, OLD.description, OLD.kind, OLD.assignee_position_id, OLD.parent_task_id, OLD.source,
      OLD.source_ref, OLD.source_event_id, OLD.created_by_type, OLD.created_by_id, OLD.created_by_run, OLD.due,
      OLD.request_depth, OLD.created_at) THEN
    RAISE EXCEPTION 'AGENT_TASK_FIELD' USING ERRCODE = '42501';
  END IF;
  NEW.tainted := NEW.tainted OR OLD.tainted OR v_ctx_tainted;
  IF OLD.status IN ('done', 'cancelled') OR NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'AGENT_TASK_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF OLD.checkout_run_id IS NULL OR OLD.lock_expires_at <= pg_catalog.now() THEN
    -- A claim never outlives the run, and changes the status at most from todo to in_progress.
    SELECT r.expires_at INTO v_run_expires FROM crove_kernel.ai_run r WHERE r.org_id = NEW.org_id AND r.id = v_run;
    IF NEW.checkout_run_id IS DISTINCT FROM v_run OR NEW.fence <> OLD.fence + 1
       OR OLD.assignee_position_id IS DISTINCT FROM (v_ctx ->> 'position')::uuid
       OR NEW.lock_expires_at IS NULL OR NEW.lock_expires_at <= pg_catalog.now()
       OR v_run_expires IS NULL OR NEW.lock_expires_at > v_run_expires
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'todo' AND NEW.status = 'in_progress')) THEN
      RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
    END IF;
    -- Claiming a tainted task taints the run (ai_run_refuse_agent_write allows exactly this write).
    IF OLD.tainted AND NOT v_ctx_tainted THEN
      UPDATE crove_kernel.ai_run SET tainted = true WHERE org_id = NEW.org_id AND id = v_run AND NOT tainted;
    END IF;
  ELSIF OLD.checkout_run_id IS DISTINCT FROM v_run OR NEW.fence <> OLD.fence
     OR (NEW.checkout_run_id IS NOT NULL AND (NEW.checkout_run_id <> v_run OR NEW.lock_expires_at > OLD.lock_expires_at)) THEN
    RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- Comments: as before, plus a tainted run's comment taints its task (an update under the lease the run holds).
CREATE OR REPLACE FUNCTION crove_kernel.task_comment_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_tainted boolean;
  v_run uuid;
  v_lock timestamptz;
BEGIN
  SELECT t.tainted, t.checkout_run_id, t.lock_expires_at INTO v_tainted, v_run, v_lock
  FROM crove_kernel.task t WHERE t.org_id = NEW.org_id AND t.id = NEW.task_id;
  NEW.tainted := NEW.tainted OR coalesce(v_tainted, false);
  IF v_ctx IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.author_type := v_ctx ->> 'actor';
  NEW.author_id := CASE v_ctx ->> 'actor' WHEN 'user' THEN (v_ctx ->> 'user')::uuid WHEN 'agent' THEN (v_ctx ->> 'agent')::uuid END;
  NEW.run_id := (v_ctx ->> 'run')::uuid;
  IF v_ctx ->> 'actor' = 'agent' THEN
    NEW.tainted := NEW.tainted OR coalesce((v_ctx ->> 'tainted')::boolean, true);
    IF v_run IS DISTINCT FROM (v_ctx ->> 'run')::uuid OR v_lock IS NULL OR v_lock <= pg_catalog.now() THEN
      RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF NEW.tainted AND NOT coalesce(v_tainted, false) THEN
      UPDATE crove_kernel.task SET tainted = true WHERE org_id = NEW.org_id AND id = NEW.task_id AND NOT tainted;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Activity rows name the agent
-- ---------------------------------------------------------------------------
ALTER TABLE crove_kernel.activity ADD COLUMN IF NOT EXISTS agent_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'activity_agent_fk' AND conrelid = 'crove_kernel.activity'::regclass) THEN
    ALTER TABLE crove_kernel.activity ADD CONSTRAINT activity_agent_fk FOREIGN KEY (org_id, agent_id) REFERENCES crove_kernel.agent (org_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS activity_agent_idx ON crove_kernel.activity (org_id, agent_id) WHERE agent_id IS NOT NULL;

-- The agent comes from the sealed context, never from the writer: set in an agent context (which names no user),
-- cleared in any other context.
CREATE OR REPLACE FUNCTION crove_kernel.activity_stamp_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
BEGIN
  IF v_ctx IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_ctx ->> 'actor' = 'agent' THEN
    NEW.agent_id := (v_ctx ->> 'agent')::uuid;
    NEW.actor_id := NULL;
  ELSE
    NEW.agent_id := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS activity_stamp_agent ON crove_kernel.activity;
CREATE TRIGGER activity_stamp_agent BEFORE INSERT ON crove_kernel.activity
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.activity_stamp_agent();

-- ---------------------------------------------------------------------------
-- The sweep returns only agents that can start a run now
-- ---------------------------------------------------------------------------
-- Same gates as kernel.agent.run.start, so a kill-switched, capped or out-of-budget agent no longer gets a refused
-- start (and its audit row) every 10 minutes; its wake-up stays pending and is found again once the gate lifts.
-- p_modules: the modules the deployment enables (CROVE_MODULES); NULL means no module filter.
DROP FUNCTION IF EXISTS crove_kernel.agent_wakeups_due(int);
CREATE OR REPLACE FUNCTION crove_kernel.agent_wakeups_due(p_limit int, p_modules text[] DEFAULT NULL)
RETURNS TABLE (org_id uuid, agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.org_id, w.agent_id
  FROM crove_kernel.agent_wakeup w
  JOIN crove_kernel.tenant t ON t.org_id = w.org_id AND t.status = 'active'
  JOIN crove_kernel.agent a ON a.org_id = w.org_id AND a.id = w.agent_id AND a.status = 'active'
  JOIN crove_kernel.agent_template tp ON tp.key = a.template_key
  JOIN crove_kernel.position p ON p.org_id = w.org_id AND p.holder_agent_id = w.agent_id AND p.status = 'active'
    AND p.role_key = tp.role_key
  WHERE w.status = 'pending'
    AND w.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 1)
    AND (p_modules IS NULL OR tp.module = ANY (p_modules))
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.ai_run r
      WHERE r.org_id = w.org_id AND r.agent_id = w.agent_id AND r.status = 'running' AND r.expires_at > pg_catalog.now())
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.kill_switch k
      WHERE k.org_id = w.org_id AND k.released_at IS NULL
        AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = p.module) OR (k.scope = 'agent' AND k.target = w.agent_id::text)))
    AND (SELECT pg_catalog.count(*) FROM crove_kernel.ai_run r
         WHERE r.org_id = w.org_id AND r.agent_id = w.agent_id
           AND r.started_at >= pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')
        < a.daily_run_cap
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.budget_policy b
      WHERE b.org_id = w.org_id AND b.hard_stop
        AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = p.module) OR (b.scope = 'agent' AND b.target = w.agent_id::text))
        AND (SELECT coalesce(pg_catalog.sum(r.cost), 0) FROM crove_kernel.ai_run r
             WHERE r.org_id = w.org_id
               AND r.started_at >= pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
               AND (b.scope = 'org' OR (b.scope = 'module' AND r.module = b.target) OR (b.scope = 'agent' AND r.agent_id::text = b.target)))
            >= b.monthly_limit)
  ORDER BY w.updated_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the new trigger functions and chart helpers for nobody but tenant roles (the helpers run inside the
-- task trigger as the writer); the sweep for the worker only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.ai_run_refuse_agent_write(),
  crove_kernel.task_escalation_target(uuid, uuid),
  crove_kernel.position_in_subtree(uuid, uuid, uuid),
  crove_kernel.activity_stamp_agent(),
  crove_kernel.agent_wakeups_due(int, text[])
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.task_escalation_target(uuid, uuid), crove_kernel.position_in_subtree(uuid, uuid, uuid) TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.agent_wakeups_due(int, text[]) TO crove_worker;
