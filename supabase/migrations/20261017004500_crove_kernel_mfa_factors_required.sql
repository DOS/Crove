-- The MFA check fails closed when auth.mfa_factors is missing (issue #180, follow-up of #126, ADR-0028 section 3).
-- Idempotent; applied files stay untouched.
--
-- 20261016180000_crove_kernel_mfa_required.sql treated a missing auth.mfa_factors as "no user has a factor": the
-- session check skipped the MFA rule and `auth-grants` only logged a warning. Every Supabase Auth version Crove ships
-- with has the table (it is created in a migration that runs before the one adding auth.sessions.not_after, which the
-- check already requires), so a missing table means a Supabase Auth schema Crove does not understand, for example an
-- upgrade that renamed or dropped it. Skipping the rule there would silently let aal1 tokens of enrolled users through.
--
-- auth_grants_ready()  now requires auth.mfa_factors and its (user_id, status) grant and SELECT policy like the
--                      other two tables, so a missing table answers 503 AUTH_NOT_READY (55000 AUTH_GRANTS_MISSING)
--                      and /readyz reports auth_grants until Supabase Auth has the table and `auth-grants` ran again.
-- session_check()      no longer checks whether the table exists before reading factors: auth_grants_ready() has
--                      already refused the request when it does not.

CREATE OR REPLACE FUNCTION crove_kernel.auth_grants_ready()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.to_regnamespace('auth') IS NULL
     OR pg_catalog.to_regclass('auth.sessions') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('auth.mfa_factors') IS NULL THEN
    RETURN false;
  END IF;
  IF NOT pg_catalog.has_schema_privilege('crove_auth_reader', 'auth', 'USAGE') THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid IN (pg_catalog.to_regclass('auth.sessions'), pg_catalog.to_regclass('auth.users'),
                    pg_catalog.to_regclass('auth.mfa_factors'))
      AND c.relrowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd IN ('r', '*')
          AND (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'crove_auth_reader') = ANY (p.polroles)
      )
  ) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1
    FROM (VALUES ('auth.sessions', 'id'), ('auth.sessions', 'user_id'), ('auth.sessions', 'not_after'),
                 ('auth.users', 'id'), ('auth.users', 'banned_until'), ('auth.users', 'deleted_at'),
                 ('auth.mfa_factors', 'user_id'), ('auth.mfa_factors', 'status')) AS c (tbl, col)
    WHERE CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = pg_catalog.to_regclass(c.tbl) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped
      ) THEN NOT pg_catalog.has_column_privilege('crove_auth_reader', pg_catalog.to_regclass(c.tbl), c.col, 'SELECT')
      ELSE true
    END
  );
END $$;

-- ---------------------------------------------------------------------------
-- Per-request check, in the request transaction (before enter_context, or before org-less work).
--   28000 SESSION_INVALID / SESSION_REVOKED -> 401
--   28000 MFA_REQUIRED                      -> 401 MFA_REQUIRED (aal1 token, user has a verified factor; db mode)
--   42501 USER_DISABLED                     -> 403
--   55000 AUTH_GRANTS_MISSING               -> 503 (`auth-grants` has not run, or a table it grants is missing)
-- p_upstream = true is the self-host db adapter; false checks the Crove records and user state only.
-- p_org_id is the org in context (NULL for org-less work).
-- p_aal is the verified token's assurance level: 'aal2' after MFA, anything else counts as aal1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.session_check(
  p_user_id uuid, p_session_id uuid, p_upstream boolean, p_org_id uuid, p_aal text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_subject text;
  v_disabled timestamptz;
  v_status text;
  v_seen timestamptz;
  v_org_status text;
  v_org_seen timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR p_upstream IS NULL OR p_aal IS NULL THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  SELECT u.subject, u.disabled_at INTO v_subject, v_disabled FROM crove_kernel.user_account u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = '42501';
  END IF;
  SELECT s.status, s.last_seen_at INTO v_status, v_seen
  FROM crove_kernel.auth_session s WHERE s.user_id = p_user_id AND s.session_id = p_session_id;
  IF v_status = 'revoked' THEN
    RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '28000';
  END IF;
  IF p_org_id IS NOT NULL THEN
    SELECT o.status, o.last_seen_at INTO v_org_status, v_org_seen
    FROM crove_kernel.auth_session_org o
    WHERE o.org_id = p_org_id AND o.user_id = p_user_id AND o.session_id = p_session_id;
    IF v_org_status = 'revoked' THEN
      RAISE EXCEPTION 'SESSION_REVOKED_IN_ORG' USING ERRCODE = '28000';
    END IF;
  END IF;
  IF p_upstream THEN
    -- Also false when auth.mfa_factors is missing: the MFA rule below is never skipped.
    IF NOT crove_kernel.auth_grants_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF v_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT crove_kernel.auth_session_valid(p_session_id, v_subject::uuid) THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    -- A live session that has not passed MFA, for a user who has a second factor: finish signing in first.
    IF p_aal <> 'aal2' AND crove_kernel.auth_user_has_verified_factor(v_subject::uuid) THEN
      RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE = '28000';
    END IF;
  END IF;
  IF v_status IS NULL THEN
    INSERT INTO crove_kernel.auth_session (user_id, session_id) VALUES (p_user_id, p_session_id)
    ON CONFLICT (user_id, session_id) DO NOTHING;
  ELSIF v_seen < pg_catalog.now() - interval '1 minute' THEN
    UPDATE crove_kernel.auth_session s SET last_seen_at = pg_catalog.now()
    WHERE s.user_id = p_user_id AND s.session_id = p_session_id AND s.status = 'active';
  END IF;
  IF p_org_id IS NOT NULL THEN
    IF v_org_status IS NULL THEN
      -- Only for a member: enter_context refuses everyone else right after this.
      IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = p_user_id) THEN
        INSERT INTO crove_kernel.auth_session_org (org_id, user_id, session_id) VALUES (p_org_id, p_user_id, p_session_id)
        ON CONFLICT (org_id, user_id, session_id) DO NOTHING;
      END IF;
    ELSIF v_org_seen < pg_catalog.now() - interval '1 minute' THEN
      UPDATE crove_kernel.auth_session_org o SET last_seen_at = pg_catalog.now()
      WHERE o.org_id = p_org_id AND o.user_id = p_user_id AND o.session_id = p_session_id AND o.status = 'active';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix, restated: only the API login role runs the check; the factor reader is reachable only through it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.auth_user_has_verified_factor(uuid),
  crove_kernel.auth_grants_ready(),
  crove_kernel.session_check(uuid, uuid, boolean, uuid, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  crove_kernel.auth_grants_ready(),
  crove_kernel.session_check(uuid, uuid, boolean, uuid, text)
TO crove_app;
