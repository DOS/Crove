-- A user with a verified MFA factor must use an aal2 token for every request (issue #126, ADR-0028 section 3).
-- Idempotent; applied files stay untouched.
--
-- Without this, a password or a recovery link alone gives an aal1 token that reads every query and runs R1 and R2
-- commands; only R3 asked for the second factor. On self-host (AUTH_SESSION_CHECK=db) the per-request session check
-- now also reads whether the user has a verified factor in Supabase Auth's auth.mfa_factors and refuses an aal1
-- token for such a user with 28000 MFA_REQUIRED (401 MFA_REQUIRED: the SPA does not sign the user out; it sends them
-- to the MFA challenge once that screen ships, issue #32, and shows the server's message until then).
--
-- auth_user_has_verified_factor()  owned by crove_auth_reader, reads auth.mfa_factors (user_id, status) only. The
--                                  `auth-grants` step grants exactly those two columns and a SELECT policy, never the
--                                  factor secrets.
-- auth_grants_ready()              also requires that grant and policy whenever auth.mfa_factors exists, so a missing
--                                  grant fails closed with 503 (AUTH_GRANTS_MISSING) instead of skipping the check.
--                                  Supabase Auth creates auth.mfa_factors in a migration that runs before the one
--                                  that adds auth.sessions.not_after, which the check already requires; a Supabase
--                                  Auth without that table has no MFA, so no user there has a factor.
-- session_check()                  gains the token's assurance level (p_aal). The four-argument version is dropped,
--                                  so no caller can skip the factor check.

-- Every verified factor counts, whatever its type: Supabase Auth itself then asks for aal2 at sign-in.
CREATE OR REPLACE FUNCTION crove_kernel.auth_user_has_verified_factor(p_subject uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM auth.mfa_factors f
    WHERE f.user_id = p_subject AND f.status::text = 'verified'
  );
END $$;

-- True once `auth-grants` has run: the tables exist, the reader may select every column the check reads and, where
-- Supabase Auth turned on row-level security, a SELECT policy lets the reader see rows. auth.mfa_factors counts once
-- it exists. A Supabase Auth schema change that drops a column makes it false, so the check fails closed with 503.
CREATE OR REPLACE FUNCTION crove_kernel.auth_grants_ready()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_mfa boolean;
BEGIN
  IF pg_catalog.to_regnamespace('auth') IS NULL
     OR pg_catalog.to_regclass('auth.sessions') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL THEN
    RETURN false;
  END IF;
  IF NOT pg_catalog.has_schema_privilege('crove_auth_reader', 'auth', 'USAGE') THEN
    RETURN false;
  END IF;
  v_mfa := pg_catalog.to_regclass('auth.mfa_factors') IS NOT NULL;
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
    FROM (VALUES ('auth.sessions', 'id', true), ('auth.sessions', 'user_id', true), ('auth.sessions', 'not_after', true),
                 ('auth.users', 'id', true), ('auth.users', 'banned_until', true), ('auth.users', 'deleted_at', true),
                 ('auth.mfa_factors', 'user_id', v_mfa), ('auth.mfa_factors', 'status', v_mfa)) AS c (tbl, col, needed)
    WHERE c.needed AND CASE
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
--   55000 AUTH_GRANTS_MISSING               -> 503 (`auth-grants` has not run)
-- p_upstream = true is the self-host db adapter; false checks the Crove records and user state only.
-- p_org_id is the org in context (NULL for org-less work).
-- p_aal is the verified token's assurance level: 'aal2' after MFA, anything else counts as aal1.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS crove_kernel.session_check(uuid, uuid, boolean, uuid);

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
    IF NOT crove_kernel.auth_grants_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF v_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT crove_kernel.auth_session_valid(p_session_id, v_subject::uuid) THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    -- A live session that has not passed MFA, for a user who has a second factor: finish signing in first. An absent
    -- auth.mfa_factors means a Supabase Auth without MFA (see the header); auth-grants warns when it is absent.
    IF p_aal <> 'aal2'
       AND pg_catalog.to_regclass('auth.mfa_factors') IS NOT NULL
       AND crove_kernel.auth_user_has_verified_factor(v_subject::uuid) THEN
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
-- Ownership: the factor reader belongs to crove_auth_reader, like the other upstream readers (see
-- 20261015090000_crove_kernel_auth_sessions.sql for why the runner needs SET ROLE and a brief CREATE).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_auth_reader TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_kernel TO crove_auth_reader;
ALTER FUNCTION crove_kernel.auth_user_has_verified_factor(uuid) OWNER TO crove_auth_reader;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_auth_reader;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role runs the check; the factor reader is reachable only through it.
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
