-- Crove kernel: the worker's member addresses leave out disabled accounts (issue #1115). Idempotent; applied files
-- stay untouched.
--
-- crove_kernel.member_emails  as defined in 20261022065000_crove_kernel_member_emails.sql, with `u.disabled_at IS NULL`:
--                             the Social notification mail and browser push (#1238), the weekly digest, the proposal
--                             reminders and the usage-limit mail all reach a member through it, so a disabled user
--                             gets none of them. Otherwise unchanged; the EXECUTE matrix (the worker login only) is
--                             restated.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_emails(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.email
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = (SELECT crove_kernel.ctx_org_id())
    AND m.user_id = ANY (p_user_ids)
    AND u.disabled_at IS NULL
$$;

-- EXECUTE matrix: only the worker login role.
REVOKE ALL ON FUNCTION crove_kernel.member_emails(uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_emails(uuid[]) TO crove_worker;
