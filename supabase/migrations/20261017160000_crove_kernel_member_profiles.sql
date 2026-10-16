-- Tenant reads of user_account go through a definer (issue #169, plan §3.6, Decision 14). Idempotent; applied files
-- stay untouched.
--
-- user_account is a control-plane table: with a second database (cell) it stays in the control plane while an org's
-- tenant data moves. A tenant transaction must then reach it only through SECURITY DEFINER functions, which a
-- multi-cell setup can reimplement as a call to the control plane without changing their callers. Until now the
-- tenant code joined user_account directly (kernel.org.get, the pending invite list, the already-a-member check of
-- kernel.member.invite.create and the target's email in the member commands), relying on the member_visibility RLS
-- policy to hide other users.
--
-- member_profiles(p_user_ids) returns id, email and display name for the given users who are members of the org in
-- the sealed context (ctx_org_id()), and nobody else: another org's members, users who share no org with the caller
-- and ids that do not exist all return no row. Without a context it returns no rows; a forged or replayed context
-- raises CONTEXT_SEAL_INVALID through ctx_verified(). It reads tenant_member to decide who is a member, which is
-- tenant data in the same cell; only the user_account lookup crosses to the control plane. Owned by the migration
-- runner like the other kernel definers (it owns both tables, so RLS does not filter its reads; the org filter is
-- explicit). Only the API login role, which runs commands and queries, may call it.
--
-- Step 2 (#222) revokes crove_tenant's SELECT on user_account and drops the member_visibility policy, once the
-- invariant suite on main accepts that; until then the grant stays, so main's copy of the suite still holds.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_profiles(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.email, u.display_name
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = (SELECT crove_kernel.ctx_org_id())
    AND m.user_id = ANY (p_user_ids)
$$;

-- EXECUTE matrix: only the API login role.
REVOKE ALL ON FUNCTION crove_kernel.member_profiles(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_profiles(uuid[]) TO crove_app;
