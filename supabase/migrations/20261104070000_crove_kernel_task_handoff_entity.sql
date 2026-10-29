-- Crove kernel (issue #1788): an agent hands a task of a legal entity only to someone who reads that entity.
-- Idempotent; applied files stay untouched.
--
-- Since #1762 a task carries a legal entity under the RESTRICTIVE le_scope policy, and a delegated or escalated child
-- takes its parent's (trigger task_legal_entity). A child handed to a holder who cannot read that entity is stuck: the
-- assignee never lists it. The database already checks where an agent sends work (T18, task_before_insert); this file
-- adds the entity to both rules, which kernel.task.delegate and kernel.task.escalate apply first with clear errors.
--
-- crove_kernel.member_covers_legal_entity(user, entity)  SECURITY DEFINER. TRUE when the user is a member of the org in
--     the sealed context whose scope, as enter_context would seal it (20261101060000_crove_kernel_roles.sql), includes
--     the entity (NULL, an org-level record: any member):
--       owner, admin   every entity;
--       member, viewer every entity while they hold no assignment or any org-wide one; otherwise the entities of their
--                      legal-entity assignments.
--     An agent limited to some entities cannot compute this from role_assignment: the RESTRICTIVE role_assignment_scope
--     policy hides the assignments outside its scope, so a person limited to another entity would look like one with no
--     assignment at all, that is, scope '*'. The definer reads the assignments as their owner and answers one boolean.
--     It answers FALSE for a user who is not a member of that org or whose org would refuse them a context (an org
--     being offboarded admits its owners only), without a context, and for an entity the caller's own scope leaves out,
--     so the caller learns nothing about entities it cannot read. A forged or replayed context raises
--     CONTEXT_SEAL_INVALID through ctx_verified(). What the caller does learn, for an entity it reads, is whether that
--     person reads it too.
-- crove_kernel.position_reads_legal_entity(org, position, entity)  whether the position's holder reads the entity: a
--     person by the definer above, an agent by the position's le_scope (what enter_agent_context seals), and a vacant
--     position by its le_scope too (an agent placed there later takes it). NULL entity: TRUE.
-- crove_kernel.task_escalation_target(org, position, entity)  the nearest active position up the chart held by a person
--     who reads the entity, or NULL (the owners at the root, who read every entity). With a NULL entity it is the
--     two-argument target of 20261018160000, which stays as it was.
-- crove_kernel.task_before_insert  main's body (20261019010000_crove_kernel_agent_write_allowlist.sql) with the parent's
--     legal entity read alongside its other fields: an agent's delegation to a position that does not read it is refused
--     (AGENT_DELEGATION_SUBTREE, the refusal for a target the agent may not send work to), and an escalation must go to
--     the entity-aware target (AGENT_ESCALATION_TARGET). The trigger fires before task_legal_entity, so it reads the
--     parent's row rather than NEW.legal_entity_id. Org-level tasks (NULL) are checked exactly as before.
--
-- EXECUTE matrix: the three helpers for the worker login role only, which runs agent commands and so writes every
-- agent task (the trigger runs them as the writer). They read and write nothing else.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_covers_legal_entity(p_user_id uuid, p_legal_entity_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((
    SELECT m.role IN ('owner', 'admin')
        OR p_legal_entity_id IS NULL
        OR EXISTS (
             SELECT 1 FROM crove_kernel.role_assignment a
             WHERE a.org_id = m.org_id AND a.user_id = m.user_id
               AND (a.legal_entity_id IS NULL OR a.legal_entity_id = p_legal_entity_id))
        OR NOT EXISTS (SELECT 1 FROM crove_kernel.role_assignment a WHERE a.org_id = m.org_id AND a.user_id = m.user_id)
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id
    WHERE m.org_id = (SELECT crove_kernel.ctx_org_id())
      AND m.user_id = p_user_id
      AND (t.status = 'active' OR (t.status = 'offboarding' AND m.role = 'owner'))
      AND (p_legal_entity_id IS NULL OR (SELECT crove_kernel.ctx_le_allowed(p_legal_entity_id)))
  ), false)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.position_reads_legal_entity(p_org_id uuid, p_position uuid, p_legal_entity_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_legal_entity_id IS NULL OR COALESCE((
    SELECT CASE WHEN p.holder_user_id IS NOT NULL
                THEN crove_kernel.member_covers_legal_entity(p.holder_user_id, p_legal_entity_id)
                ELSE '*' = ANY (p.le_scope) OR p_legal_entity_id::text = ANY (p.le_scope) END
    FROM crove_kernel.position p
    WHERE p.org_id = p_org_id AND p.id = p_position
  ), false)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.task_escalation_target(p_org_id uuid, p_position uuid, p_legal_entity_id uuid)
RETURNS uuid
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
    AND (p_legal_entity_id IS NULL OR crove_kernel.member_covers_legal_entity(p.holder_user_id, p_legal_entity_id))
  ORDER BY up.depth
  LIMIT 1
$$;

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
  v_entity uuid;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT t.request_depth, t.tainted, t.checkout_run_id, t.lock_expires_at, t.source, t.source_ref, t.legal_entity_id
      INTO v_depth, v_tainted, v_run, v_lock, v_source, v_source_ref, v_entity
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
                        WHERE p.org_id = NEW.org_id AND p.id = NEW.assignee_position_id AND p.status <> 'archived')
         -- #1788: the child takes the parent's entity, so its holder must read it.
         OR NOT crove_kernel.position_reads_legal_entity(NEW.org_id, NEW.assignee_position_id, v_entity) THEN
        RAISE EXCEPTION 'AGENT_DELEGATION_SUBTREE' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.kind = 'escalation' THEN
      IF v_position IS NULL
         OR NEW.assignee_position_id IS DISTINCT FROM crove_kernel.task_escalation_target(NEW.org_id, v_position, v_entity) THEN
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

REVOKE ALL ON FUNCTION
  crove_kernel.member_covers_legal_entity(uuid, uuid),
  crove_kernel.position_reads_legal_entity(uuid, uuid, uuid),
  crove_kernel.task_escalation_target(uuid, uuid, uuid)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION
  crove_kernel.member_covers_legal_entity(uuid, uuid),
  crove_kernel.position_reads_legal_entity(uuid, uuid, uuid),
  crove_kernel.task_escalation_target(uuid, uuid, uuid)
TO crove_worker;
