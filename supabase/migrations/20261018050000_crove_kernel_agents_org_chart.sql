-- Agents hold positions in an org chart shared with humans: ADR-0029 Phase 1, External-tenant gate T18 (issue #79).
-- Idempotent; applied files stay untouched.
--
-- agent_template  global data rows: the agent templates modules declare (finance.chief_accountant). Installing one
--                 creates an agent and a position it holds.
-- agent           an org's agent. Not a tenant member and has no role: its permissions come from the role_key of the
--                 position it holds, capped by its template (role_key must match, max_risk is the lower of the two).
-- position        a seat in the chart: at most one holder (a member or an agent). Removing the member vacates it
--                 (ON DELETE SET NULL on the holder column only). reports_to never forms a cycle: a trigger walks up
--                 the chart under a per-org advisory lock. A position without reports_to reports to the owner (root).
-- ai_run          one run of an agent; the only way an agent enters a context (enter_agent_context, worker only).
--                 At most one running run per agent.
-- task            work for a position (or, with no position, for the owner at the root of the chart): parent, source,
--                 status, request_depth (inherited, at most 5), taint (inherited), and a checkout lease with a fencing
--                 token. An agent writes a task only under a lease its run holds (trigger).
-- task_comment    append-only comments; an agent comments only under a lease its run holds.
-- agent_wakeup    coalesced wake-up requests, at most one pending per agent.
-- kill_switch     engaged per org, module or agent; stops every agent context entry it covers.
-- budget_policy   monthly hard stop per org, module or agent over ai_run cost.
--
-- Only humans manage the chart: a trigger refuses every write to position, agent, ai_run, kill_switch and
-- budget_policy made in an agent context, whatever command or statement makes it (defense in depth behind the
-- runtime, which never lets an agent run a command that does not declare agent access).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Audit rows can name an agent.
-- ---------------------------------------------------------------------------
-- Widening a CHECK: every existing row already passes. The runner applies a file in one transaction, so the scan runs
-- under the ACCESS EXCLUSIVE lock either way (NOT VALID plus VALIDATE would not shorten it here).
ALTER TABLE crove_kernel.audit_event DROP CONSTRAINT IF EXISTS audit_event_actor_type_check;
ALTER TABLE crove_kernel.audit_event ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('user', 'system', 'agent'));

-- ---------------------------------------------------------------------------
-- Context helpers for agent contexts (NULL in user and system contexts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.ctx_agent_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (crove_kernel.ctx_verified() ->> 'agent')::uuid
$$;

CREATE OR REPLACE FUNCTION crove_kernel.ctx_run_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (crove_kernel.ctx_verified() ->> 'run')::uuid
$$;

CREATE OR REPLACE FUNCTION crove_kernel.ctx_position_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (crove_kernel.ctx_verified() ->> 'position')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Templates (global data, no org_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.agent_template (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$'),
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]*$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  role_key text NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_.]*$'),
  -- The ceiling: an agent of this template never runs above it, whatever its own max_risk says.
  max_risk text NOT NULL CHECK (max_risk IN ('R0', 'R1', 'R2')),
  job_description jsonb NOT NULL CHECK (jsonb_typeof(job_description) = 'object'),
  -- Event types that create a task for the agent and wake it (Inbox triage).
  subscribes text[] NOT NULL DEFAULT '{}',
  daily_run_cap int NOT NULL DEFAULT 50 CHECK (daily_run_cap BETWEEN 1 AND 10000)
);
REVOKE ALL ON crove_kernel.agent_template FROM PUBLIC;
GRANT SELECT ON crove_kernel.agent_template TO crove_tenant;

INSERT INTO crove_kernel.agent_template (key, module, title, role_key, max_risk, job_description, subscribes, daily_run_cap)
VALUES (
  'finance.chief_accountant', 'finance', 'Kế toán trưởng (AI)', 'finance.chief_accountant', 'R1',
  '{"responsibilities": ["Rà soát chứng từ mua vào mới trong Hộp duyệt AI", "Ghi nhận kết quả kiểm tra và chuyển cho người duyệt"], "kpis": ["Chứng từ mới được rà soát trong ngày"], "workingHours": "always", "limits": ["Không ghi sổ, không duyệt: việc ghi sổ và ký do người có chứng chỉ thực hiện"]}'::jsonb,
  ARRAY['kernel.proposal.created'], 50)
ON CONFLICT (key) DO UPDATE SET
  module = EXCLUDED.module, title = EXCLUDED.title, role_key = EXCLUDED.role_key, max_risk = EXCLUDED.max_risk,
  job_description = EXCLUDED.job_description, subscribes = EXCLUDED.subscribes, daily_run_cap = EXCLUDED.daily_run_cap;

-- ---------------------------------------------------------------------------
-- Agents, positions, runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.agent (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  template_key text NOT NULL REFERENCES crove_kernel.agent_template (key),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  runtime text NOT NULL DEFAULT 'builtin' CHECK (runtime IN ('builtin', 'external')),
  model_alias text CHECK (model_alias IS NULL OR length(model_alias) <= 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  max_risk text NOT NULL DEFAULT 'R1' CHECK (max_risk IN ('R0', 'R1', 'R2')),
  daily_run_cap int NOT NULL DEFAULT 50 CHECK (daily_run_cap BETWEEN 1 AND 10000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.agent');
REVOKE DELETE ON crove_kernel.agent FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.position (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]*$'),
  role_key text NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_.]*$'),
  reports_to uuid,
  holder_user_id uuid,
  holder_agent_id uuid,
  -- Legal entities and sensitivity flags of the seat; none by default (ADR-0029 section 1).
  le_scope text[] NOT NULL DEFAULT '{}',
  flags text[] NOT NULL DEFAULT '{}',
  job_description jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(job_description) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT position_one_holder CHECK (num_nonnulls(holder_user_id, holder_agent_id) <= 1),
  CONSTRAINT position_not_own_supervisor CHECK (reports_to IS DISTINCT FROM id),
  CONSTRAINT position_reports_to_fk FOREIGN KEY (org_id, reports_to) REFERENCES crove_kernel.position (org_id, id),
  -- Removing a member vacates the seat: only holder_user_id is set to NULL (PostgreSQL 15+ column list).
  CONSTRAINT position_holder_user_fk FOREIGN KEY (org_id, holder_user_id)
    REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (holder_user_id),
  CONSTRAINT position_holder_agent_fk FOREIGN KEY (org_id, holder_agent_id) REFERENCES crove_kernel.agent (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS position_agent_uq ON crove_kernel.position (org_id, holder_agent_id) WHERE holder_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS position_reports_to_idx ON crove_kernel.position (org_id, reports_to);
CREATE INDEX IF NOT EXISTS position_holder_user_idx ON crove_kernel.position (org_id, holder_user_id) WHERE holder_user_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.position');
REVOKE DELETE ON crove_kernel.position FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.ai_run (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  agent_id uuid NOT NULL,
  -- The module of the position at start, for module budgets.
  module text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'expired', 'cancelled')),
  tainted boolean NOT NULL DEFAULT true,
  request_depth int NOT NULL DEFAULT 0 CHECK (request_depth BETWEEN 0 AND 5),
  cost numeric(18, 6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  error text CHECK (error IS NULL OR length(error) <= 1000),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, agent_id) REFERENCES crove_kernel.agent (org_id, id),
  CHECK (expires_at > started_at),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
-- One run per agent at a time (ADR-0029 section 5).
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_one_running_uq ON crove_kernel.ai_run (org_id, agent_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ai_run_agent_time_idx ON crove_kernel.ai_run (org_id, agent_id, started_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.ai_run');
REVOKE DELETE ON crove_kernel.ai_run FROM crove_tenant;

-- ---------------------------------------------------------------------------
-- Tasks and comments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.task (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text CHECK (description IS NULL OR length(description) <= 10000),
  kind text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'proposal_review', 'escalation', 'delegation')),
  -- NULL: the owner, root of the chart.
  assignee_position_id uuid,
  parent_task_id uuid,
  source text NOT NULL CHECK (source IN ('event', 'proposal', 'human', 'schedule')),
  -- The record the task is about, e.g. {"type": "kernel.proposal", "id": "<uuid>"}.
  source_ref jsonb CHECK (source_ref IS NULL OR jsonb_typeof(source_ref) = 'object'),
  source_event_id uuid,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'system', 'agent')),
  created_by_id uuid,
  created_by_run uuid,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled')),
  due timestamptz,
  -- Delegation and escalation hops from the root task (inherited through parent_task_id by a trigger).
  request_depth int NOT NULL DEFAULT 0 CHECK (request_depth BETWEEN 0 AND 5),
  tainted boolean NOT NULL DEFAULT false,
  -- Checkout lease: the run holding the task, until when, and the fencing token every write under it carries.
  checkout_run_id uuid,
  lock_expires_at timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CHECK ((checkout_run_id IS NULL) = (lock_expires_at IS NULL)),
  FOREIGN KEY (org_id, assignee_position_id) REFERENCES crove_kernel.position (org_id, id),
  FOREIGN KEY (org_id, parent_task_id) REFERENCES crove_kernel.task (org_id, id),
  FOREIGN KEY (org_id, checkout_run_id) REFERENCES crove_kernel.ai_run (org_id, id)
);
CREATE INDEX IF NOT EXISTS task_assignee_idx ON crove_kernel.task (org_id, assignee_position_id, status);
CREATE INDEX IF NOT EXISTS task_parent_idx ON crove_kernel.task (org_id, parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_checkout_idx ON crove_kernel.task (org_id, checkout_run_id) WHERE checkout_run_id IS NOT NULL;
-- One task per event and position, so a redelivered event creates nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS task_source_event_uq ON crove_kernel.task (org_id, source_event_id, assignee_position_id)
  WHERE source_event_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.task');
REVOKE DELETE ON crove_kernel.task FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.task_comment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  task_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  author_type text NOT NULL CHECK (author_type IN ('user', 'system', 'agent')),
  author_id uuid,
  run_id uuid,
  tainted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, task_id) REFERENCES crove_kernel.task (org_id, id)
);
CREATE INDEX IF NOT EXISTS task_comment_task_idx ON crove_kernel.task_comment (org_id, task_id, created_at);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.task_comment', true);
SELECT crove_kernel.make_append_only('crove_kernel.task_comment');

-- ---------------------------------------------------------------------------
-- Wake-ups, kill switches, budgets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.agent_wakeup (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done')),
  -- Why the agent was woken, newest last (task ids and reasons), capped by the coalescing upsert.
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  request_count int NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  tainted boolean NOT NULL DEFAULT true,
  request_depth int NOT NULL DEFAULT 0 CHECK (request_depth BETWEEN 0 AND 5),
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, agent_id) REFERENCES crove_kernel.agent (org_id, id),
  FOREIGN KEY (org_id, run_id) REFERENCES crove_kernel.ai_run (org_id, id),
  CHECK ((status = 'pending') = (run_id IS NULL))
);
-- Coalesced per agent: at most one pending request.
CREATE UNIQUE INDEX IF NOT EXISTS agent_wakeup_pending_uq ON crove_kernel.agent_wakeup (org_id, agent_id) WHERE status = 'pending';
-- For the sweep of wake-ups left pending (agent_wakeups_due).
CREATE INDEX IF NOT EXISTS agent_wakeup_pending_due_idx ON crove_kernel.agent_wakeup (updated_at) WHERE status = 'pending';
SELECT crove_kernel.apply_tenant_rls('crove_kernel.agent_wakeup');
REVOKE DELETE ON crove_kernel.agent_wakeup FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.kill_switch (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  scope text NOT NULL CHECK (scope IN ('org', 'module', 'agent')),
  -- '*' for the org, the module id, or the agent id.
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 100),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  engaged_by uuid NOT NULL,
  engaged_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  PRIMARY KEY (org_id, id),
  CHECK ((scope = 'org') = (target = '*')),
  -- Canonical targets only (a lowercase uuid, a module id), so the text comparisons at entry always match.
  CONSTRAINT kill_switch_target_canonical CHECK (
    (scope <> 'agent' OR target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND (scope <> 'module' OR target ~ '^[a-z][a-z0-9_]*$')),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS kill_switch_active_uq ON crove_kernel.kill_switch (org_id, scope, target) WHERE released_at IS NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.kill_switch');
REVOKE DELETE ON crove_kernel.kill_switch FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.budget_policy (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  scope text NOT NULL CHECK (scope IN ('org', 'module', 'agent')),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 100),
  -- ai_run cost per calendar month (Asia/Ho_Chi_Minh).
  monthly_limit numeric(18, 6) NOT NULL CHECK (monthly_limit >= 0),
  warn_percent int NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 1 AND 100),
  hard_stop boolean NOT NULL DEFAULT true,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CHECK ((scope = 'org') = (target = '*')),
  CONSTRAINT budget_policy_target_canonical CHECK (
    (scope <> 'agent' OR target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND (scope <> 'module' OR target ~ '^[a-z][a-z0-9_]*$'))
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_policy_target_uq ON crove_kernel.budget_policy (org_id, scope, target);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.budget_policy');
REVOKE DELETE ON crove_kernel.budget_policy FROM crove_tenant;

-- ---------------------------------------------------------------------------
-- Only humans manage the chart (ADR-0029 section 3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.refuse_agent_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() = 'agent' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['position', 'agent', 'ai_run', 'kill_switch', 'budget_policy'] LOOP
    EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS refuse_agent_write ON crove_kernel.%I', t);
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER refuse_agent_write BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.%I '
      'FOR EACH ROW EXECUTE FUNCTION crove_kernel.refuse_agent_write()', t);
  END LOOP;
END $$;

-- No reporting cycle. Runs as the definer owner so the walk sees the whole chart of the org, and under a per-org
-- advisory lock, so two concurrent changes check one after the other: the second walk is a new statement and, at
-- READ COMMITTED (every Crove transaction), sees what the first committed. Other isolation levels would walk an old
-- snapshot, so chart changes there are refused.
CREATE OR REPLACE FUNCTION crove_kernel.position_no_cycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.reports_to IS NULL THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'POSITION_CHART_ISOLATION' USING ERRCODE = '25001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.position.chart:' || NEW.org_id::text, 0));
  IF NEW.reports_to = NEW.id OR EXISTS (
    WITH RECURSIVE up (id) AS (
      SELECT NEW.reports_to
      UNION
      SELECT p.reports_to FROM crove_kernel.position p JOIN up ON p.org_id = NEW.org_id AND p.id = up.id
      WHERE p.reports_to IS NOT NULL
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'POSITION_CYCLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS position_no_cycle ON crove_kernel.position;
CREATE TRIGGER position_no_cycle BEFORE INSERT OR UPDATE OF reports_to ON crove_kernel.position
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.position_no_cycle();

-- A holder or status change releases every lease on the position's tasks (ADR-0029 section 4).
CREATE OR REPLACE FUNCTION crove_kernel.position_release_leases() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_kernel.task t SET checkout_run_id = NULL, lock_expires_at = NULL
  WHERE t.org_id = NEW.org_id AND t.assignee_position_id = NEW.id AND t.checkout_run_id IS NOT NULL;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS position_release_leases ON crove_kernel.position;
CREATE TRIGGER position_release_leases AFTER UPDATE OF holder_user_id, holder_agent_id, status ON crove_kernel.position
  FOR EACH ROW
  WHEN (OLD.holder_user_id IS DISTINCT FROM NEW.holder_user_id OR OLD.holder_agent_id IS DISTINCT FROM NEW.holder_agent_id
        OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION crove_kernel.position_release_leases();

-- ---------------------------------------------------------------------------
-- Task rules every writer meets
-- ---------------------------------------------------------------------------
-- On insert: request_depth and taint come from the parent; the creator is stamped from the context; an agent creates
-- a task only as a child of a task its run holds (a delegation or an escalation), and its tasks carry the run's taint.
CREATE OR REPLACE FUNCTION crove_kernel.task_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_found boolean := false;
  v_depth int;
  v_tainted boolean;
  v_run uuid;
  v_lock timestamptz;
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
    NEW.checkout_run_id := NULL;
    NEW.lock_expires_at := NULL;
    NEW.fence := 0;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS task_before_insert ON crove_kernel.task;
CREATE TRIGGER task_before_insert BEFORE INSERT ON crove_kernel.task
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.task_before_insert();

-- On update in an agent context: only lease and status change; a claim takes a free or expired lease on a task of
-- the agent's own position and increments the fencing token; every other write needs the lease held by this run,
-- keeps the token and may only release (never extend) the lease. Agents never cancel and never touch closed tasks.
CREATE OR REPLACE FUNCTION crove_kernel.task_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_run uuid;
  v_run_expires timestamptz;
BEGIN
  NEW.updated_at := pg_catalog.now();
  IF v_ctx IS NULL OR v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    RETURN NEW;
  END IF;
  v_run := (v_ctx ->> 'run')::uuid;
  IF (NEW.org_id, NEW.id, NEW.title, NEW.description, NEW.kind, NEW.assignee_position_id, NEW.parent_task_id, NEW.source,
      NEW.source_ref, NEW.source_event_id, NEW.created_by_type, NEW.created_by_id, NEW.created_by_run, NEW.due,
      NEW.request_depth, NEW.tainted, NEW.created_at)
     IS DISTINCT FROM
     (OLD.org_id, OLD.id, OLD.title, OLD.description, OLD.kind, OLD.assignee_position_id, OLD.parent_task_id, OLD.source,
      OLD.source_ref, OLD.source_event_id, OLD.created_by_type, OLD.created_by_id, OLD.created_by_run, OLD.due,
      OLD.request_depth, OLD.tainted, OLD.created_at) THEN
    RAISE EXCEPTION 'AGENT_TASK_FIELD' USING ERRCODE = '42501';
  END IF;
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
  ELSIF OLD.checkout_run_id IS DISTINCT FROM v_run OR NEW.fence <> OLD.fence
     OR (NEW.checkout_run_id IS NOT NULL AND (NEW.checkout_run_id <> v_run OR NEW.lock_expires_at > OLD.lock_expires_at)) THEN
    RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS task_before_update ON crove_kernel.task;
CREATE TRIGGER task_before_update BEFORE UPDATE ON crove_kernel.task
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.task_before_update();

-- Comments: the author comes from the context, taint from the task (and the run); an agent comments only under a
-- lease its run holds.
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
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS task_comment_before_insert ON crove_kernel.task_comment;
CREATE TRIGGER task_comment_before_insert BEFORE INSERT ON crove_kernel.task_comment
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.task_comment_before_insert();

-- ---------------------------------------------------------------------------
-- Agent context entry (plan §4.5 items 2 and 3, ADR-0029 section 2)
-- ---------------------------------------------------------------------------
-- Enters the context of a position-holding agent for one of its runs. Worker only (EXECUTE and session_user). Every
-- fact comes from the database, nothing from parameters but the three ids, which must match one live run: the run is
-- running and not expired, the agent is active and holds an active position whose role_key is its template's, no kill
-- switch covers the org, the module or the agent, and no hard-stop budget is spent. The org is the run's org, so an
-- agent never enters another org. max_risk is the lower of the agent's and its template's. Like enter_context, it
-- reads without row locks (it also runs in READ ONLY transactions): a run finished or a switch engaged concurrently
-- takes effect from the next transaction.
CREATE OR REPLACE FUNCTION crove_kernel.enter_agent_context(p_org_id uuid, p_agent_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_run_status text;
  v_run_expires timestamptz;
  v_run_tainted boolean;
  v_agent_status text;
  v_agent_risk text;
  v_template_risk text;
  v_template_role text;
  v_position uuid;
  v_role text;
  v_module text;
  v_le text[];
  v_flags text[];
  v_risk text;
  v_month timestamptz;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'AGENT_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  SELECT r.status, r.expires_at, r.tainted INTO v_run_status, v_run_expires, v_run_tainted
  FROM crove_kernel.ai_run r WHERE r.org_id = p_org_id AND r.id = p_run_id AND r.agent_id = p_agent_id;
  IF NOT FOUND OR v_run_status <> 'running' OR v_run_expires <= pg_catalog.now() THEN
    RAISE EXCEPTION 'AGENT_RUN_NOT_LIVE' USING ERRCODE = '42501';
  END IF;
  SELECT a.status, a.max_risk, t.max_risk, t.role_key INTO v_agent_status, v_agent_risk, v_template_risk, v_template_role
  FROM crove_kernel.agent a JOIN crove_kernel.agent_template t ON t.key = a.template_key
  WHERE a.org_id = p_org_id AND a.id = p_agent_id;
  IF NOT FOUND OR v_agent_status <> 'active' THEN
    RAISE EXCEPTION 'AGENT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  SELECT p.id, p.role_key, p.module, p.le_scope, p.flags INTO v_position, v_role, v_module, v_le, v_flags
  FROM crove_kernel.position p WHERE p.org_id = p_org_id AND p.holder_agent_id = p_agent_id AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NO_POSITION' USING ERRCODE = '42501';
  END IF;
  IF v_role <> v_template_role THEN
    RAISE EXCEPTION 'AGENT_ROLE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k
    WHERE k.org_id = p_org_id AND k.released_at IS NULL
      AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = v_module) OR (k.scope = 'agent' AND k.target = p_agent_id::text))
  ) THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  v_month := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF EXISTS (
    SELECT 1 FROM crove_kernel.budget_policy b
    WHERE b.org_id = p_org_id AND b.hard_stop
      AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = v_module) OR (b.scope = 'agent' AND b.target = p_agent_id::text))
      AND (SELECT coalesce(sum(r.cost), 0) FROM crove_kernel.ai_run r
           WHERE r.org_id = p_org_id AND r.started_at >= v_month
             AND (b.scope = 'org' OR (b.scope = 'module' AND r.module = b.target) OR (b.scope = 'agent' AND r.agent_id::text = b.target)))
          >= b.monthly_limit
  ) THEN
    RAISE EXCEPTION 'BUDGET_EXHAUSTED' USING ERRCODE = '42501';
  END IF;
  v_risk := CASE WHEN v_agent_risk < v_template_risk THEN v_agent_risk ELSE v_template_risk END;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'agent',
    'user', NULL,
    'role', v_role,
    'agent', p_agent_id,
    'run', p_run_id,
    'position', v_position,
    'module', v_module,
    'max_risk', v_risk,
    'tainted', v_run_tainted,
    'le_scope', pg_catalog.to_jsonb(v_le),
    'flags', pg_catalog.to_jsonb(v_flags)));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'position', v_position, 'module', v_module, 'maxRisk', v_risk, 'tainted', v_run_tainted);
END $$;

-- Agents with a wake-up left pending (cross-org, worker only): pending for over a minute, active agent and org, and no
-- live run. A wake-up stays pending when the run it asked for was refused (daily cap, kill switch, budget, a run still
-- live after a worker crash); the worker's periodic sweep wakes those agents again. Reads ids only.
CREATE OR REPLACE FUNCTION crove_kernel.agent_wakeups_due(p_limit int)
RETURNS TABLE (org_id uuid, agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.org_id, w.agent_id
  FROM crove_kernel.agent_wakeup w
  JOIN crove_kernel.tenant t ON t.org_id = w.org_id AND t.status = 'active'
  JOIN crove_kernel.agent a ON a.org_id = w.org_id AND a.id = w.agent_id AND a.status = 'active'
  WHERE w.status = 'pending'
    AND w.updated_at < pg_catalog.now() - pg_catalog.make_interval(mins => 1)
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.ai_run r
      WHERE r.org_id = w.org_id AND r.agent_id = w.agent_id AND r.status = 'running' AND r.expires_at > pg_catalog.now())
  ORDER BY w.updated_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

-- Refusal tally (20261017040000): an agent's refusals are counted under agent:<agent id>, so its refusal audit rows
-- are bounded per agent like a user's. Same body otherwise; CREATE OR REPLACE keeps owner and grants.
CREATE OR REPLACE FUNCTION crove_kernel.refusal_tally_note(
  p_command text, p_code text, p_security boolean, p_actor_limit integer, p_org_limit integer, p_reserve integer,
  p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_actor text;
  v_window timestamptz;
  v_actor_n bigint;
  v_org_n bigint;
  v_seen boolean;
  v_audit boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type = 'user' AND v_user IS NOT NULL THEN
    v_actor := 'user:' || v_user::text;
  ELSIF v_actor_type = 'system' THEN
    v_actor := 'system';
  ELSIF v_actor_type = 'agent' AND crove_kernel.ctx_agent_id() IS NOT NULL THEN
    v_actor := 'agent:' || crove_kernel.ctx_agent_id()::text;
  ELSE
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_command IS NULL OR pg_catalog.length(p_command) NOT BETWEEN 1 AND 200
     OR p_code IS NULL OR pg_catalog.length(p_code) NOT BETWEEN 1 AND 100
     OR p_security IS NULL
     OR p_actor_limit IS NULL OR p_actor_limit NOT BETWEEN 1 AND 999999
     OR p_org_limit IS NULL OR p_org_limit NOT BETWEEN 1 AND 999999
     OR p_reserve IS NULL OR p_reserve NOT BETWEEN 0 AND p_actor_limit
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'REFUSAL_TALLY_INVALID' USING ERRCODE = '22023';
  END IF;

  v_window := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', v_now) / p_window_seconds) * p_window_seconds);

  -- Rows of one org and window: one per actor and (command, code), read through the primary key.
  SELECT COALESCE(pg_catalog.sum(t.refusals) FILTER (WHERE t.actor_key = v_actor), 0),
         COALESCE(pg_catalog.sum(t.refusals), 0),
         COALESCE(pg_catalog.bool_or(t.actor_key = v_actor AND t.command = p_command AND t.code = p_code), false)
    INTO v_actor_n, v_org_n, v_seen
  FROM crove_kernel.refusal_tally t
  WHERE t.org_id = v_org AND t.window_start = v_window;

  v_audit := NOT v_seen
    OR v_actor_n < p_reserve
    OR (v_actor_n < p_actor_limit AND (p_security OR v_org_n < p_org_limit));

  INSERT INTO crove_kernel.refusal_tally AS t (org_id, window_start, actor_key, command, code, refusals, audited, first_at, last_at)
  VALUES (v_org, v_window, v_actor, p_command, p_code, 1, CASE WHEN v_audit THEN 1 ELSE 0 END, v_now, v_now)
  ON CONFLICT (org_id, window_start, actor_key, command, code) DO UPDATE
    SET refusals = t.refusals + 1,
        audited = t.audited + EXCLUDED.audited,
        last_at = GREATEST(t.last_at, EXCLUDED.last_at);
  RETURN v_audit;
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: nothing for PUBLIC; the helpers for tenant roles; agent entry for the worker login role only; the
-- trigger functions for nobody (they run only as triggers).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.ctx_agent_id(),
  crove_kernel.ctx_run_id(),
  crove_kernel.ctx_position_id(),
  crove_kernel.refuse_agent_write(),
  crove_kernel.position_no_cycle(),
  crove_kernel.position_release_leases(),
  crove_kernel.task_before_insert(),
  crove_kernel.task_before_update(),
  crove_kernel.task_comment_before_insert(),
  crove_kernel.enter_agent_context(uuid, uuid, uuid),
  crove_kernel.agent_wakeups_due(int)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_agent_id(), crove_kernel.ctx_run_id(), crove_kernel.ctx_position_id() TO crove_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_agent_context(uuid, uuid, uuid), crove_kernel.agent_wakeups_due(int) TO crove_worker;
