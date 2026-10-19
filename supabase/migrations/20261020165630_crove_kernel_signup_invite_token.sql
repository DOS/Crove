-- Restricted sign-up needs the invite link, not just an invited address (issue #563). Idempotent.
--
-- The problem. Supabase Auth keeps the password of the first unconfirmed sign-up for an address and does not update
-- the user on a later sign-up for it (v2.197 internal/api/signup.go, "do not update the user"); it only mails the
-- confirmation again. Under AUTH_SIGNUP_POLICY=invite_only the proxy forwarded a sign-up for any address that held a
-- valid invite (signup_invite_valid, 20261020150000), so whoever knew an invitee's address could sign up first with
-- their own password. Supabase Auth mailed the confirmation to the invitee, who expects mail from the org; once
-- confirmed, the account carried the attacker's password, and after the invitee accepted the invite (or the attacker
-- did, with the link) the attacker signed in as a member of the org.
--
-- The fix. While the policy is restricted, the sign-up for an invited address must carry that invite's token (the
-- secret in the accept link, mailed to the invited address): the web app sends the token it holds from the link in a
-- request header, and the proxy asks this function before forwarding. Nobody who lacks the link can create the
-- account, so the first password Supabase Auth keeps for an invited address is one chosen by someone who opened the
-- link.
--
-- crove_kernel.signup_invite_token_valid(email, token)  true when the token names an invite for exactly this email
--                                                       (in the stored form: trimmed, lower case) that is pending,
--                                                       unexpired, in an active org, and whose inviter may still grant
--                                                       its role: the conditions signup_invite_valid() checks, bound to
--                                                       one invite by its token. A malformed token, another address,
--                                                       or a revoked, accepted or expired invite answer false. One
--                                                       boolean: nothing about the org, role or inviter.
--
-- signup_invite_valid(email) stays as it is: under allowlist an address at an allowed domain that holds an invite
-- also needs the token, and the proxy asks that function to know whether it does.
--
-- Only crove_app (the API login role, which runs the proxy) may execute it, like signup_invite_valid.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.signup_invite_token_valid(p_email text, p_token text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_email IS NULL OR p_email <> pg_catalog.lower(pg_catalog.btrim(p_email))
     OR pg_catalog.length(p_email) NOT BETWEEN 3 AND 320 OR p_email NOT LIKE '_%@_%' THEN
    RETURN false;
  END IF;
  -- The token format invite_for_user() accepts: 32 random bytes, base64url without padding.
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM crove_kernel.member_invite i
    JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
    JOIN crove_kernel.tenant_member m ON m.org_id = i.org_id AND m.user_id = i.invited_by
    WHERE i.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
      AND i.email = p_email
      AND i.status = 'pending'
      AND i.expires_at > pg_catalog.now()
      AND m.role IN ('owner', 'admin')
      AND (i.role <> 'admin' OR m.role = 'owner'));
END $$;

-- crove_app alone.
REVOKE ALL ON FUNCTION crove_kernel.signup_invite_token_valid(text, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
GRANT EXECUTE ON FUNCTION crove_kernel.signup_invite_token_valid(text, text) TO crove_app;
