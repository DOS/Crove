-- The deployment-wide kill switch (issue #886, plan §4.12 "Kill switches", Phase 1 exit criterion 8). Idempotent;
-- applied files stay untouched.
--
-- An org's "Dừng AI" (crove_kernel.kill_switch) stops that org's agents and AI document reading. The operator also
-- needs one switch for the whole deployment: a compromised or runaway AI endpoint, or a mail provider that must not be
-- used, in every org at once. It is control-plane data (plan §3.6): no org owns it and no tenant code may name it.
--
-- crove_kernel.global_kill_switch           an append-only history, one row per change: key 'ai' or 'mail', engaged
--                                           or released, the reason and who (the operator's name, free text). The
--                                           latest row of a key is its state; no row means off.
-- crove_kernel.global_kill_switch_on(key)   whether a key is engaged now. Read by the extraction job, the agent gates
--                                           and the mail queue; every runtime role may call it.
-- crove_kernel.global_kill_switch_set(...)  engages or releases a key. No Crove role may call it: only the database
--                                           owner, through the operator's script (pnpm ops:kill-switch), which needs
--                                           the admin URL the migrations use. That is the break-glass path.
--
-- enter_agent_context refuses an agent context while 'ai' is engaged (KILL_SWITCH_ON), as it does for an org switch.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.global_kill_switch (
  id uuid PRIMARY KEY DEFAULT crove_kernel.uuid_v7(),
  key text NOT NULL CHECK (key IN ('ai', 'mail')),
  engaged boolean NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  changed_by text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 100),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS global_kill_switch_key_idx ON crove_kernel.global_kill_switch (key, changed_at DESC, id DESC);
ALTER TABLE crove_kernel.global_kill_switch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.global_kill_switch FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
SELECT crove_kernel.make_append_only('crove_kernel.global_kill_switch');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.global_kill_switch');

CREATE OR REPLACE FUNCTION crove_kernel.global_kill_switch_on(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT s.engaged FROM crove_kernel.global_kill_switch s WHERE s.key = p_key ORDER BY s.changed_at DESC, s.id DESC LIMIT 1),
    false)
$$;
REVOKE ALL ON FUNCTION crove_kernel.global_kill_switch_on(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.global_kill_switch_on(text) TO crove_app, crove_worker, crove_tenant, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.global_kill_switch_set(p_key text, p_engaged boolean, p_reason text, p_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO crove_kernel.global_kill_switch (key, engaged, reason, changed_by)
  VALUES (p_key, p_engaged, NULLIF(pg_catalog.btrim(p_reason), ''), p_by);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.global_kill_switch_set(text, boolean, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The agent context, as in 20261018050000, with the deployment-wide 'ai' switch after the org's own switches.
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
  -- The deployment-wide switch for AI (#886), engaged by the operator.
  IF crove_kernel.global_kill_switch_on('ai') THEN
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
