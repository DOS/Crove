-- Crove kernel (issue #1279, plan §4.6 and the v0 table list): roles, their permissions and role assignments, and the
-- legal-entity scope of the sealed context derived from them. Idempotent; applied files stay untouched.
--
-- crove_kernel.role             the built-in roles of the plan a member can be given on top of their base role
--                               (tenant_member.role: owner, admin, member, viewer, which stay where they are): global
--                               data rows, like agent_template. scope says whether an assignment of the role covers the
--                               whole org ('org') or names one legal entity ('legal_entity': external_accountant).
--                               team_lead waits for teams; custom roles (per-org permission sets) are a later table.
-- crove_kernel.role_permission  the permissions each role grants. Only permissions something checks are seeded:
--                               finance.proposal.approve (P12 eligibility for the ledger's proposals, approval.ts) and
--                               finance.period.unlock (ADR-0021 section 3: the chief accountant reopens a period too).
-- crove_kernel.role_assignment  who holds which role in the org, org-wide or for one legal entity. The member foreign
--                               key cascades, so removing a member removes their assignments (plan §4.6, revocation
--                               through membership); the role foreign key carries the scope, so an org-wide role never
--                               names an entity and an entity role always does.
--
-- Writes: only owners grant and revoke (plan §4.6: privileged permissions come only from an assignment granted by a
-- Crove owner), through the audited R3 commands kernel.member.role.assign and kernel.member.role.revoke. Tenant roles
-- only read the table; the two definers below write it and check again that the context is a user who owns the org,
-- so neither a raw call, an admin, nor a system or agent context grants anything. Revoking the last legal-entity
-- assignment of a member or viewer is refused: it would lift their scope to every entity (see enter_context below).
--
-- What reads assignments: enter_context (the le_scope below), crove_kernel.ctx_has_permission (the runtime's gate for
-- commands that declare a permission, and finance's unlock_period), and the approval policy (P12). Each reads them in
-- the transaction of the command it decides, so a revoke or a removal applies from the member's next command.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.role (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
  -- The module the role belongs to (the key's prefix, 'kernel' for a key without one): the commands offer a role only
  -- when the deployment runs its module.
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]*$'),
  scope text NOT NULL CHECK (scope IN ('org', 'legal_entity')),
  CONSTRAINT role_key_scope_uq UNIQUE (key, scope)
);

CREATE TABLE IF NOT EXISTS crove_kernel.role_permission (
  role_key text NOT NULL REFERENCES crove_kernel.role (key),
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  PRIMARY KEY (role_key, permission)
);

INSERT INTO crove_kernel.role (key, module, scope) VALUES
  ('finance.chief_accountant', 'finance', 'org'),
  ('finance.accountant', 'finance', 'org'),
  ('finance.viewer', 'finance', 'org'),
  ('crm.sales', 'crm', 'org'),
  ('desk.agent', 'desk', 'org'),
  ('hr.manager', 'hr', 'org'),
  ('external_accountant', 'kernel', 'legal_entity')
ON CONFLICT (key) DO NOTHING;

INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES
  ('finance.chief_accountant', 'finance.proposal.approve'),
  ('finance.chief_accountant', 'finance.period.unlock')
ON CONFLICT (role_key, permission) DO NOTHING;

-- Catalog: everyone reads it, no runtime role writes it (migrations do), and no agent context either.
REVOKE ALL ON crove_kernel.role, crove_kernel.role_permission FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT ON crove_kernel.role, crove_kernel.role_permission TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.role');
SELECT crove_kernel.agent_write_guard_install('crove_kernel.role_permission');

CREATE TABLE IF NOT EXISTS crove_kernel.role_assignment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  role_key text NOT NULL,
  -- NULL: the whole org. Otherwise the one legal entity the assignment covers.
  legal_entity_id uuid,
  scope text NOT NULL GENERATED ALWAYS AS (CASE WHEN legal_entity_id IS NULL THEN 'org' ELSE 'legal_entity' END) STORED,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT role_assignment_member_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT role_assignment_legal_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT role_assignment_role_fk FOREIGN KEY (role_key, scope) REFERENCES crove_kernel.role (key, scope),
  -- One assignment per member, role and entity (the whole org counting as one).
  CONSTRAINT role_assignment_uq UNIQUE NULLS NOT DISTINCT (org_id, user_id, role_key, legal_entity_id)
);
-- The legal entity key's index (G3 fk-index); the member key uses role_assignment_uq.
CREATE INDEX IF NOT EXISTS role_assignment_legal_entity_idx ON crove_kernel.role_assignment (org_id, legal_entity_id) WHERE legal_entity_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_kernel.role_assignment');
-- Read only for tenant roles: the definers below are the only writers (the member key's cascade runs as the owner).
REVOKE INSERT, UPDATE, DELETE ON crove_kernel.role_assignment FROM crove_tenant;

-- The legal-entity scope of the sealed context (plan §4.6), RESTRICTIVE so it narrows the tenant policy and never
-- widens it: an org-wide assignment is seen by every member of the org, an entity's assignment only within that
-- entity's scope.
DROP POLICY IF EXISTS role_assignment_scope ON crove_kernel.role_assignment;
CREATE POLICY role_assignment_scope ON crove_kernel.role_assignment AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (legal_entity_id IS NULL OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
         OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK (legal_entity_id IS NULL OR '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
              OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- Raises ROLE_MANAGE_FORBIDDEN (42501) unless the sealed context is a user who owns the org in context. The commands
-- check the same first (under their membership locks); this keeps a raw call, an admin, or a system or agent context
-- from granting or revoking. Called only from the two definers below, so it runs as their owner.
CREATE OR REPLACE FUNCTION crove_kernel.assert_role_manager() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = crove_kernel.ctx_org_id() AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'ROLE_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.assert_role_manager() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Grants p_role_key to the member p_user_id of the org in context, for the whole org (p_legal_entity_id NULL) or for
-- one of its legal entities, as the role's scope requires. Answers the assignment and whether this call created it
-- (false: the member already held it). Refusals, all P0001 with the code as message: ROLE_MEMBER_NOT_FOUND,
-- ROLE_NOT_FOUND, ROLE_SCOPE_REQUIRED (an entity role without an entity), ROLE_SCOPE_NOT_ALLOWED (an org-wide role
-- with one), ROLE_LEGAL_ENTITY_NOT_FOUND, and ROLE_SCOPE_NOT_FOR_ADMINS: an owner or admin sees every entity whatever
-- they hold, so an entity assignment would limit nothing.
CREATE OR REPLACE FUNCTION crove_kernel.role_assignment_grant(p_user_id uuid, p_role_key text, p_legal_entity_id uuid)
RETURNS TABLE (assignment_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_member_role text;
  v_scope text;
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.assert_role_manager();
  SELECT m.role INTO v_member_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user_id;
  IF v_member_role IS NULL THEN
    RAISE EXCEPTION 'ROLE_MEMBER_NOT_FOUND';
  END IF;
  SELECT r.scope INTO v_scope FROM crove_kernel.role r WHERE r.key = p_role_key;
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;
  IF v_scope = 'legal_entity' AND p_legal_entity_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_SCOPE_REQUIRED';
  END IF;
  IF v_scope = 'org' AND p_legal_entity_id IS NOT NULL THEN
    RAISE EXCEPTION 'ROLE_SCOPE_NOT_ALLOWED';
  END IF;
  IF p_legal_entity_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM crove_kernel.legal_entity e WHERE e.org_id = v_org AND e.id = p_legal_entity_id) THEN
      RAISE EXCEPTION 'ROLE_LEGAL_ENTITY_NOT_FOUND';
    END IF;
    IF v_member_role IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'ROLE_SCOPE_NOT_FOR_ADMINS';
    END IF;
  END IF;
  INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
  VALUES (v_org, p_user_id, p_role_key, p_legal_entity_id, crove_kernel.ctx_user_id())
  ON CONFLICT ON CONSTRAINT role_assignment_uq DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT a.id, false FROM crove_kernel.role_assignment a
    WHERE a.org_id = v_org AND a.user_id = p_user_id AND a.role_key = p_role_key
      AND a.legal_entity_id IS NOT DISTINCT FROM p_legal_entity_id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.role_assignment_grant(uuid, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.role_assignment_grant(uuid, text, uuid) TO crove_tenant;

-- Revokes the assignment p_assignment_id of the org in context and answers what it was. Refusals (P0001):
-- ROLE_ASSIGNMENT_NOT_FOUND, and ROLE_REVOKE_WIDENS_SCOPE: the last legal-entity assignment of a member or viewer with
-- no org-wide one is what limits them to those entities (enter_context), so revoking it would let them see every
-- entity. A revoke may narrow what a member reaches, never widen it; removing the member ends their access instead.
CREATE OR REPLACE FUNCTION crove_kernel.role_assignment_revoke(p_assignment_id uuid)
RETURNS TABLE (user_id uuid, role_key text, legal_entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_row crove_kernel.role_assignment%ROWTYPE;
  v_member_role text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.assert_role_manager();
  SELECT a.* INTO v_row FROM crove_kernel.role_assignment a WHERE a.org_id = v_org AND a.id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROLE_ASSIGNMENT_NOT_FOUND';
  END IF;
  SELECT m.role INTO v_member_role FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_row.user_id;
  IF v_row.legal_entity_id IS NOT NULL AND v_member_role NOT IN ('owner', 'admin') AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a
    WHERE a.org_id = v_org AND a.user_id = v_row.user_id AND a.id <> v_row.id
  ) THEN
    RAISE EXCEPTION 'ROLE_REVOKE_WIDENS_SCOPE';
  END IF;
  DELETE FROM crove_kernel.role_assignment a WHERE a.org_id = v_org AND a.id = v_row.id;
  RETURN QUERY SELECT v_row.user_id, v_row.role_key, v_row.legal_entity_id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.role_assignment_revoke(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.role_assignment_revoke(uuid) TO crove_tenant;

-- Whether the user of the sealed context holds p_permission in the org in context through an org-wide assignment. An
-- assignment for one legal entity grants no permission yet: no record names an entity, so nothing could be checked
-- against it (P12's legal-entity part waits for legal_entity_id on proposals). Every other actor, and no context,
-- holds none. SECURITY INVOKER: a tenant role reads its own org's rows through RLS; the finance definer that calls it
-- reads as its owner, filtered by the same context.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_has_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(crove_kernel.ctx_actor_type() = 'user', false) AND EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a
    JOIN crove_kernel.role_permission p ON p.role_key = a.role_key
    WHERE a.org_id = crove_kernel.ctx_org_id() AND a.user_id = crove_kernel.ctx_user_id()
      AND a.legal_entity_id IS NULL AND p.permission = p_permission
  )
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_has_permission(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_has_permission(text) TO crove_tenant;

-- ---------------------------------------------------------------------------
-- enter_context: le_scope from the member's assignments instead of always '*'. Same signature, membership check,
-- write fence and context shape as 20261028130000; CREATE OR REPLACE keeps owner and ACL.
--   owner, admin   '*': they administer the whole org, whatever they hold;
--   member, viewer '*' while they hold no assignment or any org-wide one; with only legal-entity assignments, exactly
--                  those entities (sorted, so one set seals to one text). A scoped member therefore sees only those
--                  entities in every table under a legal-entity scope policy, legal_entity today.
-- The assignments are read in the transaction that enters, so a narrower scope applies from the next command.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_context(p_user_id uuid, p_org_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text;
  v_scope jsonb;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'offboarding') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('kernel.org.purge:' || p_org_id::text, 0));
  END IF;
  -- A new statement: after waiting on a purge it sees the org closed.
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.org_id = p_org_id AND m.user_id = p_user_id
    AND (t.status = 'active' OR (t.status = 'offboarding' AND m.role = 'owner'));
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'admin') AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a
    WHERE a.org_id = p_org_id AND a.user_id = p_user_id AND a.legal_entity_id IS NULL
  ) THEN
    SELECT pg_catalog.jsonb_agg(DISTINCT a.legal_entity_id::text ORDER BY a.legal_entity_id::text) INTO v_scope
    FROM crove_kernel.role_assignment a
    WHERE a.org_id = p_org_id AND a.user_id = p_user_id;
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'user',
    'user', p_user_id,
    'role', v_role,
    'le_scope', COALESCE(v_scope, pg_catalog.jsonb_build_array('*')),
    'flags', '[]'::jsonb));
  RETURN v_role;
END $$;
