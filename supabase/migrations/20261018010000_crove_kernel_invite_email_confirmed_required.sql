-- Invites fail closed without auth.users.email_confirmed_at (issue #208, second step of #134). Idempotent.
--
-- 20261017010000 made accepting and previewing an invite in db mode (p_upstream) require a confirmed email in
-- Supabase Auth's own record, but skipped that check when auth.users had no email_confirmed_at column at all (the
-- `auth-grants` step only warned), because the invariant suite's fake auth.users did not carry the column yet. Every
-- fixture now has it (#208 step 1), so a missing column fails closed: invite_for_user raises AUTH_GRANTS_MISSING
-- (55000, answered 503 AUTH_NOT_READY) whenever p_upstream is true and auth_email_check_ready() is false, which
-- covers the column being absent as well as its grant. Supabase Auth adds the column in an early migration, before
-- the one creating auth.sessions, which `auth-grants` already waits for; `auth-grants` now waits for the column too
-- and always grants it.
--
-- Scope: only the invite definers read the column, so only they fail closed. auth_grants_ready() and the session
-- check of every other request are unchanged; failing every request because invites cannot be checked would turn a
-- weaker invite path into a full outage without protecting anything else. This differs from auth.mfa_factors
-- (20261017004500), which the session check itself reads on every request.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- True when the session check's grants are in place, auth.users has email_confirmed_at and the reader may select
-- it. Was called only after the column was known to exist; now also the existence test, made a separate step
-- because has_column_privilege() raises 42703 for a column that does not exist and SQL does not promise to
-- evaluate AND left to right.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.auth_email_check_ready()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT crove_kernel.auth_grants_ready() THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pg_catalog.to_regclass('auth.users') AND a.attname = 'email_confirmed_at'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RETURN false;
  END IF;
  RETURN pg_catalog.has_column_privilege('crove_auth_reader', pg_catalog.to_regclass('auth.users'), 'email_confirmed_at', 'SELECT');
END $$;

-- ---------------------------------------------------------------------------
-- The invite a token names, with the checks every invitee-facing call shares (see 20261017010000). Unchanged except
-- that with p_upstream the confirmed-email check is no longer conditional on the column existing. Raises (P0001,
-- mapped by the kernel): INVITE_NOT_FOUND, INVITE_EMAIL_MISMATCH, INVITE_EMAIL_UNCONFIRMED, INVITE_USED,
-- INVITE_REVOKED, INVITE_EXPIRED; and AUTH_GRANTS_MISSING (55000).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.invite_for_user(p_user_id uuid, p_token text, p_lock boolean, p_upstream boolean)
RETURNS crove_kernel.member_invite LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite;
  v_email text;
  v_subject text;
  v_inviter_role text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' OR p_lock IS NULL OR p_upstream IS NULL THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  SELECT i.* INTO v_invite FROM crove_kernel.member_invite i
  WHERE i.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_invite.id IS NULL
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_invite.org_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  -- The inviter's membership row first, then the invite (the member commands' order). FOR SHARE when accepting, so
  -- a role change or removal of the inviter that commits first is seen and one that starts later waits; the invite
  -- row is then re-read under its lock (READ COMMITTED returns its newest version).
  IF p_lock THEN
    SELECT m.role INTO v_inviter_role FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by FOR SHARE;
    SELECT i.* INTO v_invite FROM crove_kernel.member_invite i
    WHERE i.org_id = v_invite.org_id AND i.id = v_invite.id FOR UPDATE;
    IF v_invite.id IS NULL THEN
      RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT m.role INTO v_inviter_role FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by;
  END IF;
  SELECT pg_catalog.lower(pg_catalog.btrim(u.email)), u.subject INTO v_email, v_subject
  FROM crove_kernel.user_account u WHERE u.id = p_user_id AND u.disabled_at IS NULL;
  IF v_email IS NULL OR v_email <> v_invite.email THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- db mode: Supabase Auth must have a confirmed email for the user. auth_email_check_ready() is false when the
  -- session check's grants are missing, when auth.users has no email_confirmed_at, or when the reader cannot select
  -- it; each fails closed.
  IF p_upstream THEN
    IF NOT crove_kernel.auth_email_check_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF v_subject IS NULL OR v_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT crove_kernel.auth_email_confirmed(v_subject::uuid) THEN
      RAISE EXCEPTION 'INVITE_EMAIL_UNCONFIRMED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF v_invite.status = 'accepted' THEN
    RAISE EXCEPTION 'INVITE_USED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status = 'revoked' THEN
    RAISE EXCEPTION 'INVITE_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  -- The inviter must still be allowed to grant the role: an owner or admin, and an owner for an admin invite.
  -- kernel.member.change_role and kernel.member.remove revoke such invites in the same transaction; this check stays
  -- as the backstop for any other path that changes a membership.
  IF v_inviter_role IS NULL OR v_inviter_role NOT IN ('owner', 'admin') OR (v_invite.role = 'admin' AND v_inviter_role <> 'owner') THEN
    RAISE EXCEPTION 'INVITE_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_invite;
END $$;

-- EXECUTE matrix (restated): the helper and the Supabase Auth readers are callable by nobody (they run inside the
-- invite definers); only the API login role accepts and previews invites.
REVOKE ALL ON FUNCTION
  crove_kernel.auth_email_confirmed(uuid),
  crove_kernel.auth_email_check_ready(),
  crove_kernel.invite_for_user(uuid, text, boolean, boolean),
  crove_kernel.invite_accept(uuid, text, boolean),
  crove_kernel.invite_peek(uuid, text, boolean)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

GRANT EXECUTE ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean), crove_kernel.invite_peek(uuid, text, boolean) TO crove_app;
