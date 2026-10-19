-- Invite-only sign-up (issue #350): may this email create an account? Idempotent.
--
-- With AUTH_SIGNUP_POLICY=invite_only (or allowlist, where an invite also admits an address outside the allowed
-- domains), the kernel's /auth/v1 proxy forwards a sign-up to the bundled Supabase Auth only when the email holds a
-- valid member invite. This file adds the check it asks:
--
-- crove_kernel.signup_invite_valid(email)  true when some org has an invite for exactly this email that is pending,
--                                          unexpired, in an active org, and whose inviter may still grant its role
--                                          (an owner or admin, and an owner for an admin invite): the conditions
--                                          invite_for_user() checks when the invite is accepted. Revoked, accepted
--                                          and expired invites never count. The email must already be in the form
--                                          invites store it (trimmed, lower case); anything else is false. The
--                                          answer is one boolean: it says nothing about which org, role or inviter.
--
-- Only crove_app (the API login role, which runs the proxy) may execute it. It reads tenant tables across orgs, so it
-- is a definer with the pinned search_path, like the other control-plane checks the proxy makes (auth_email_reserve).
SET LOCAL lock_timeout = '2s';

-- The lookup by email across orgs; the existing pending index leads with org_id.
CREATE INDEX IF NOT EXISTS member_invite_pending_email_idx ON crove_kernel.member_invite (email) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION crove_kernel.signup_invite_valid(p_email text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_email IS NULL OR p_email <> pg_catalog.lower(pg_catalog.btrim(p_email))
     OR pg_catalog.length(p_email) NOT BETWEEN 3 AND 320 OR p_email NOT LIKE '_%@_%' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM crove_kernel.member_invite i
    JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
    JOIN crove_kernel.tenant_member m ON m.org_id = i.org_id AND m.user_id = i.invited_by
    WHERE i.email = p_email
      AND i.status = 'pending'
      AND i.expires_at > pg_catalog.now()
      AND m.role IN ('owner', 'admin')
      AND (i.role <> 'admin' OR m.role = 'owner'));
END $$;

-- crove_app alone.
REVOKE ALL ON FUNCTION crove_kernel.signup_invite_valid(text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.signup_invite_valid(text) TO crove_app;
