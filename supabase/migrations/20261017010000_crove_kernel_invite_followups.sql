-- Member invite follow-ups (issue #134, after #35). Idempotent; applied files stay untouched.
--
-- Confirmed email (AUTH_SESSION_CHECK=db, defense in depth). Accepting or previewing an invite already requires the
-- signed-in user's email (user_account.email, written only from verified access tokens) to be the invited one. On
-- self-host the database also holds Supabase Auth's own record, so the invite definers now take p_upstream (true in
-- db mode, the same flag session_check gets) and then also require auth.users.email_confirmed_at for the user's
-- subject. A token minted for an account whose email was never confirmed (autoconfirm off, a provider that does not
-- verify) cannot join an org.
--   auth_email_confirmed()   owned by crove_auth_reader like the other Supabase Auth readers; reads only id and
--                            email_confirmed_at. The column grant comes from the `auth-grants` step (as the others).
--   Fails closed: while auth.users has the column but the reader cannot select it (auth-grants has not run since
--   this release), the invite definers raise AUTH_GRANTS_MISSING (55000, answered 503). The column is not part of
--   auth_grants_ready(), so the session check of every other request is unaffected.
--   Not yet closed: a Supabase Auth without the column at all skips the check (`auth-grants` warns). Every Supabase
--   Auth release has it, but the invariant suite's fake auth.users on main does not, and that suite accepts invites
--   in db mode, so failing closed there is an invariant change. It lands in a second step, as auth.mfa_factors did
--   (20261017004500, #180), once the fixtures carry the column (#134).
--
-- Lock order. invite_for_user (accepting) used to lock the invite row and then the inviter's membership row. The
-- member commands (change_role, remove) lock membership rows and then update the inviter's pending invites, which
-- kernel.member.change_role now does as well (revoking invites the inviter can no longer issue). Accepting now reads
-- the invite, locks the inviter's membership row FOR SHARE and only then locks the invite FOR UPDATE, so both paths
-- take membership rows before invite rows and never deadlock. A demotion or removal that commits first is seen (the
-- invite is revoked or the inviter's role is too low), one that starts later waits for the acceptance.
--
-- The two-argument invite_accept and invite_peek are dropped, so no caller can skip the new check.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Supabase Auth reader: is the subject's email confirmed? PL/pgSQL, so the body is not resolved before Supabase
-- Auth has created its tables.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.auth_email_confirmed(p_subject uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = p_subject AND u.email_confirmed_at IS NOT NULL AND u.email_confirmed_at <= pg_catalog.now()
  );
END $$;

-- True when the reader may select every column auth_email_confirmed() reads (and the session check's grants are in
-- place). Called only when auth.users has email_confirmed_at; false then means the grant is missing (fail closed).
CREATE OR REPLACE FUNCTION crove_kernel.auth_email_check_ready()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT crove_kernel.auth_grants_ready() THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pg_catalog.to_regclass('auth.users') AND a.attname = 'email_confirmed_at'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) AND pg_catalog.has_column_privilege('crove_auth_reader', pg_catalog.to_regclass('auth.users'), 'email_confirmed_at', 'SELECT');
END $$;

-- Ownership: like auth_session_valid, the reader belongs to crove_auth_reader (see 20261015090000).
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_auth_reader TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_kernel TO crove_auth_reader;
ALTER FUNCTION crove_kernel.auth_email_confirmed(uuid) OWNER TO crove_auth_reader;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_auth_reader;

-- ---------------------------------------------------------------------------
-- The invite a token names, with the checks every invitee-facing call shares (see 20261015200000), plus, when
-- p_upstream, the confirmed email. Raises (P0001, mapped by the kernel): INVITE_NOT_FOUND, INVITE_EMAIL_MISMATCH,
-- INVITE_EMAIL_UNCONFIRMED (db mode: Supabase Auth has no confirmed email for the user; after the email match, so
-- only the invitee learns it), INVITE_USED, INVITE_REVOKED, INVITE_EXPIRED; and AUTH_GRANTS_MISSING (55000).
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
  IF p_upstream AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pg_catalog.to_regclass('auth.users') AND a.attname = 'email_confirmed_at'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
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

-- Accepts the invite the token names for p_user_id and returns its org (see 20261015200000). p_upstream: the
-- deployment reads Supabase Auth's tables (AUTH_SESSION_CHECK=db).
CREATE OR REPLACE FUNCTION crove_kernel.invite_accept(p_user_id uuid, p_token text, p_upstream boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, true, p_upstream);
BEGIN
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
  VALUES (v_invite.org_id, p_user_id, v_invite.role)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  UPDATE crove_kernel.member_invite
  SET status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  RETURN v_invite.org_id;
END $$;

-- What the invitee consents to. Same checks as accepting.
CREATE OR REPLACE FUNCTION crove_kernel.invite_peek(p_user_id uuid, p_token text, p_upstream boolean)
RETURNS TABLE (org_name text, role text, invited_by_email text, invited_by_name text, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, false, p_upstream);
BEGIN
  RETURN QUERY
  SELECT t.name, v_invite.role, u.email, u.display_name, v_invite.expires_at
  FROM crove_kernel.tenant t
  JOIN crove_kernel.user_account u ON u.id = v_invite.invited_by
  WHERE t.org_id = v_invite.org_id;
END $$;

DROP FUNCTION IF EXISTS crove_kernel.invite_accept(uuid, text);
DROP FUNCTION IF EXISTS crove_kernel.invite_peek(uuid, text);
DROP FUNCTION IF EXISTS crove_kernel.invite_for_user(uuid, text, boolean);

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role accepts and previews invites; the helpers and the Supabase Auth reader are
-- callable by nobody (they run inside the definers).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.auth_email_confirmed(uuid),
  crove_kernel.auth_email_check_ready(),
  crove_kernel.invite_for_user(uuid, text, boolean, boolean),
  crove_kernel.invite_accept(uuid, text, boolean),
  crove_kernel.invite_peek(uuid, text, boolean)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

GRANT EXECUTE ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean), crove_kernel.invite_peek(uuid, text, boolean) TO crove_app;
