-- Agent contexts write only an allowlist of tables (ADR-0029, issue #285). Idempotent; applied files stay untouched.
--
-- Before: refuse_agent_write named the tables an agent context may not write (a denylist), so every other tenant
-- table was open to it. Now crove_kernel.agent_write_guard sits on every table of every crove_* schema except
-- crove_meta (the migration ledger) and crove_jobs (pg-boss, written by the worker outside any context), and refuses
-- every row an agent context inserts, updates or deletes, except:
--   - tables with their own agent rules, which carry no guard: task and task_comment (writes under the run's lease),
--     ai_run (only tainting its own run), activity (the agent stamped from the context), and the tables only
--     definers write while an agent acts: outbox_event (crove_kernel.emit; no tenant privilege) and refusal_tally
--     (refusal_tally_note);
--   - four tables written for an agent, which carry the guard with a narrow rule:
--       audit_event      rows of this agent and run only (actor_type 'agent', actor_id the context's agent,
--                        detail.agentRun the context's run), dated now;
--       idempotency_key  keys of this run only (actor_key 'agent:<agent>:<run>', as the runtime builds it);
--       agent_wakeup     pending requests for an agent holding a position below the context's (the agents a
--                        delegation wakes) only: inserted pending with one request, updated while pending and kept
--                        pending, taint never cleared (and set when the run is tainted), count and depth never lowered;
--       outbox_pending   inserts only (crove_kernel.emit), so an agent transaction never claims or drops another
--                        org's pending events (crove_kernel.outbox_claim deletes them).
-- New tables are guarded by default: apply_tenant_rls installs the guard on every table it sets up, and the invariant
-- suite enumerates the catalog and fails on any crove_* table without it that is not on the list above.
--
-- The guard runs as its owner (SECURITY DEFINER), so it reads the sealed context whatever role writes the row,
-- including definer owners and control-plane roles that hold no EXECUTE on the ctx_* helpers. It replaces nothing:
-- refuse_agent_write stays on its twelve tables (the invariant suite of the base branch expects it there) and fires
-- after this guard, which refuses with the same AGENT_FORBIDDEN.
--
-- Also: an agent never delegates to an archived position (task_before_insert, as kernel.task.delegate).
--
-- Known gap: crove_jobs (pg-boss) is outside the guard. pg-boss owns those tables and the worker login role writes
-- them, so an agent transaction could enqueue jobs with raw SQL; the runtime never does (#333 tracks it).
--
-- The install loop takes a short ACCESS EXCLUSIVE lock per table (DROP and CREATE TRIGGER); with lock_timeout 2s a
-- busy table fails the migration fast, and it is safe to run again.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.agent_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_agent uuid;
  v_key text;
BEGIN
  IF v_ctx IS NULL OR v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  v_agent := (v_ctx ->> 'agent')::uuid;
  IF TG_TABLE_SCHEMA = 'crove_kernel' AND TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'audit_event' THEN
      IF TG_OP = 'INSERT' AND NEW.actor_type = 'agent' AND NEW.actor_id = v_agent
         AND NEW.detail ->> 'agentRun' = (v_ctx ->> 'run') THEN
        NEW.occurred_at := pg_catalog.now();
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'outbox_pending' THEN
      IF TG_OP = 'INSERT' THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'idempotency_key' THEN
      v_key := 'agent:' || v_agent::text || ':' || (v_ctx ->> 'run');
      IF NEW.actor_key = v_key THEN
        IF TG_OP = 'INSERT' THEN
          RETURN NEW;
        END IF;
        IF OLD.actor_key = v_key THEN
          RETURN NEW;
        END IF;
      END IF;
    ELSIF TG_TABLE_NAME = 'agent_wakeup' THEN
      IF NEW.status = 'pending' AND NEW.run_id IS NULL AND EXISTS (
           SELECT 1 FROM crove_kernel.position p
           WHERE p.org_id = NEW.org_id AND p.holder_agent_id = NEW.agent_id
             AND crove_kernel.position_in_subtree(NEW.org_id, (v_ctx ->> 'position')::uuid, p.id)) THEN
        IF TG_OP = 'INSERT' THEN
          NEW.request_count := 1;
          NEW.tainted := NEW.tainted OR crove_kernel.ctx_run_tainted();
          RETURN NEW;
        END IF;
        IF OLD.status = 'pending' AND OLD.org_id = NEW.org_id AND OLD.id = NEW.id AND OLD.agent_id = NEW.agent_id
           AND OLD.created_at = NEW.created_at AND NEW.request_count >= OLD.request_count
           AND NEW.request_depth >= OLD.request_depth THEN
          NEW.tainted := NEW.tainted OR OLD.tainted OR crove_kernel.ctx_run_tainted();
          RETURN NEW;
        END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END $$;

-- The tables an agent context writes under rules of their own, so they carry no guard.
CREATE OR REPLACE FUNCTION crove_kernel.agent_write_exempt(p_table regclass) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_table::text = ANY (ARRAY[
    'crove_kernel.task', 'crove_kernel.task_comment', 'crove_kernel.ai_run', 'crove_kernel.activity',
    'crove_kernel.outbox_event', 'crove_kernel.refusal_tally'])
$$;

-- Installs the guard on a table unless it is exempt. Called below for every existing table and by apply_tenant_rls
-- for every table set up later. A partition inherits its parent's trigger, so it is left alone.
CREATE OR REPLACE FUNCTION crove_kernel.agent_write_guard_install(p_table regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = p_table AND c.relispartition) THEN
    RETURN;
  END IF;
  EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS agent_write_guard ON %s', p_table);
  IF NOT crove_kernel.agent_write_exempt(p_table) THEN
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER agent_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH ROW EXECUTE FUNCTION crove_kernel.agent_write_guard()', p_table);
  END IF;
END $$;

-- Every exempt table exists (a renamed one would otherwise drop out of the list unnoticed).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crove_kernel.task', 'crove_kernel.task_comment', 'crove_kernel.ai_run', 'crove_kernel.activity',
    'crove_kernel.outbox_event', 'crove_kernel.refusal_tally'] LOOP
    IF pg_catalog.to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'agent write allowlist names a missing table: %', t;
    END IF;
  END LOOP;
END $$;

-- Every table of every crove_* schema but the migration ledger and pg-boss (partitions inherit the parent's trigger).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS t
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname LIKE 'crove\_%' AND n.nspname NOT IN ('crove_meta', 'crove_jobs')
      AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    PERFORM crove_kernel.agent_write_guard_install(r.t);
  END LOOP;
END $$;

-- New tenant tables get the guard where they get RLS (same body as 20261013120000 otherwise, with the pinned
-- search_path every function now uses).
CREATE OR REPLACE FUNCTION crove_kernel.apply_tenant_rls(t regclass, append_only boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE pg_catalog.format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
  EXECUTE pg_catalog.format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO crove_tenant '
    'USING (org_id = (SELECT crove_kernel.ctx_org_id())) WITH CHECK (org_id = (SELECT crove_kernel.ctx_org_id()))', t);
  EXECUTE pg_catalog.format('REVOKE ALL ON %s FROM PUBLIC, crove_tenant', t);
  IF append_only THEN
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON %s TO crove_tenant', t);
  ELSE
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO crove_tenant', t);
  END IF;
  PERFORM crove_kernel.agent_write_guard_install(t);
END $$;

-- ---------------------------------------------------------------------------
-- No delegation to an archived position (replaces the 20261018160000 body; only the delegation check changes)
-- ---------------------------------------------------------------------------
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
  v_source text;
  v_source_ref jsonb;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT t.request_depth, t.tainted, t.checkout_run_id, t.lock_expires_at, t.source, t.source_ref
      INTO v_depth, v_tainted, v_run, v_lock, v_source, v_source_ref
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
    NEW.tainted := NEW.tainted OR crove_kernel.ctx_run_tainted();
    IF NOT v_found OR v_run IS DISTINCT FROM (v_ctx ->> 'run')::uuid OR v_lock IS NULL OR v_lock <= pg_catalog.now() THEN
      RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
    END IF;
    v_position := (v_ctx ->> 'position')::uuid;
    IF NEW.kind = 'delegation' THEN
      IF NEW.assignee_position_id IS NULL OR v_position IS NULL
         OR NOT crove_kernel.position_in_subtree(NEW.org_id, v_position, NEW.assignee_position_id)
         OR NOT EXISTS (SELECT 1 FROM crove_kernel.position p
                        WHERE p.org_id = NEW.org_id AND p.id = NEW.assignee_position_id AND p.status <> 'archived') THEN
        RAISE EXCEPTION 'AGENT_DELEGATION_SUBTREE' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.kind = 'escalation' THEN
      IF v_position IS NULL OR NEW.assignee_position_id IS DISTINCT FROM crove_kernel.task_escalation_target(NEW.org_id, v_position) THEN
        RAISE EXCEPTION 'AGENT_ESCALATION_TARGET' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'AGENT_TASK_KIND' USING ERRCODE = '42501';
    END IF;
    NEW.source := v_source;
    NEW.source_ref := v_source_ref;
    NEW.source_event_id := NULL;
    NEW.status := 'todo';
    NEW.due := NULL;
    NEW.created_at := pg_catalog.now();
    NEW.checkout_run_id := NULL;
    NEW.lock_expires_at := NULL;
    NEW.fence := 0;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: the guard and its helpers for nobody (the guard runs only as a trigger; the helpers only here and
-- in apply_tenant_rls, which migrations call as the owner).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.agent_write_guard(),
  crove_kernel.agent_write_exempt(regclass),
  crove_kernel.agent_write_guard_install(regclass)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
