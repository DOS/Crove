-- Crove kernel (issue #1788): whether a member of the org in context reads a legal entity, for the agent commands that
-- hand a task to a person (kernel.task.delegate, kernel.task.escalate). Idempotent; applied files stay untouched.
--
-- Since #1762 a task carries a legal entity under the RESTRICTIVE le_scope policy, so a task handed to someone who
-- cannot read its entity is stuck: the assignee never lists it. The agent's command must therefore know a person's
-- scope, which is enter_context's rule (20261101060000_crove_kernel_roles.sql):
--   owner, admin   every entity;
--   member, viewer every entity while they hold no assignment or any org-wide one; otherwise the entities of their
--                  legal-entity assignments.
-- An agent limited to some entities cannot compute it from role_assignment: the RESTRICTIVE role_assignment_scope
-- policy hides the assignments outside its scope, so a person limited to another entity would look like one with no
-- assignment at all, that is, scope '*'. This definer reads the assignments as their owner and answers one boolean.
--
-- member_covers_legal_entity(p_user_id, p_legal_entity_id) is TRUE when p_user_id is a member of the org in the sealed
-- context whose scope, as enter_context would seal it, includes the entity (NULL, an org-level record: any member). It
-- answers FALSE for a user who is not a member of that org, or whose org would refuse them a context (an org being
-- offboarded admits its owners only), without a context, and for an entity the caller's own scope leaves out, so the
-- caller learns nothing about entities it cannot read. A forged or replayed context raises CONTEXT_SEAL_INVALID
-- through ctx_verified(). What the caller does learn, for an entity it reads, is whether that person reads it too.
--
-- EXECUTE matrix: only the worker login role, which runs agent commands. Read only (STABLE); it writes nothing.
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

REVOKE ALL ON FUNCTION crove_kernel.member_covers_legal_entity(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_covers_legal_entity(uuid, uuid) TO crove_worker;
