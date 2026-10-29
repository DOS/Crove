-- Crove kernel (issue #1507, from #1280 part 2a / #1503): a permission held for some legal entities only, and the
-- role that grants period unlock that way. Idempotent; applied files stay untouched.
--
-- Since #1503 each legal entity locks its own months, but the one role that unlocks them, finance.chief_accountant, is
-- org-wide: a member could only be given every entity's unlock or none. A role's scope is one of 'org' or
-- 'legal_entity' (role_assignment's foreign key on (role_key, scope) keeps an org role from naming an entity), so the
-- entity chief accountant is a role of its own:
--
-- finance.entity_chief_accountant  scope 'legal_entity' (one entity per assignment, as external_accountant; never an
--     owner's or admin's, who see every entity anyway); grants finance.period.unlock for the assigned entities alone.
--     It grants no approval: P12 and the approval gate count org-wide assignments only (#1279, #1793). A member who
--     holds only such assignments sees only those entities (enter_context's le_scope).
-- crove_kernel.ctx_permission_entities(permission)  where the user of the sealed context holds the permission: '*' for
--     an org-wide assignment, else the ids (as text, sorted) of the entities of their entity assignments; empty for a
--     viewer (who holds no permission), for any other actor and without a context. ctx_has_permission is unchanged
--     (org-wide only), so nothing that reads it gains an entity holder. Read as the writer, like ctx_has_permission:
--     the user's own assignments are within their scope.
SET LOCAL lock_timeout = '2s';

INSERT INTO crove_kernel.role (key, module, scope) VALUES ('finance.entity_chief_accountant', 'finance', 'legal_entity')
ON CONFLICT (key) DO NOTHING;
INSERT INTO crove_kernel.role_permission (role_key, permission) VALUES ('finance.entity_chief_accountant', 'finance.period.unlock')
ON CONFLICT (role_key, permission) DO NOTHING;

CREATE OR REPLACE FUNCTION crove_kernel.ctx_permission_entities(p_permission text) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN COALESCE(crove_kernel.ctx_actor_type() = 'user', false) THEN ARRAY(
    SELECT DISTINCT CASE WHEN a.legal_entity_id IS NULL THEN '*' ELSE a.legal_entity_id::text END
    FROM crove_kernel.role_assignment a
    JOIN crove_kernel.role_permission p ON p.role_key = a.role_key
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.user_id
    WHERE a.org_id = crove_kernel.ctx_org_id() AND a.user_id = crove_kernel.ctx_user_id()
      AND p.permission = p_permission AND m.role <> 'viewer'
    ORDER BY 1) ELSE ARRAY[]::text[] END
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_permission_entities(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_permission_entities(text) TO crove_tenant;
