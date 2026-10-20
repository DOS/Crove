-- Member addresses for the worker's mail (issue #579). Idempotent; applied files stay untouched.
--
-- member_emails(p_user_ids) is member_profiles for the worker: the email of each given user who is a member of the org
-- of the context (ctx_org_id()), and nobody else; no context, no rows. The worker enters an org's system context to
-- queue the mail that org sends its members (Social notifications); member_profiles stays the API's alone (its
-- EXECUTE matrix is an invariant). Only the address: no display name, no other column of user_account.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_emails(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.email
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = (SELECT crove_kernel.ctx_org_id())
    AND m.user_id = ANY (p_user_ids)
$$;

-- EXECUTE matrix: only the worker login role.
REVOKE ALL ON FUNCTION crove_kernel.member_emails(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_emails(uuid[]) TO crove_worker;
