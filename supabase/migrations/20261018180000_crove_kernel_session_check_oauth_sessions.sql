-- The db session check refuses Supabase Auth sessions bound to an OAuth client (issue #276, follow-up of #272,
-- ADR-0028 section 1 and fact 11). Idempotent; applied files stay untouched.
--
-- The kernel refuses access tokens issued to OAuth clients by their claims (`client_id`, or an `oauth_provider/`
-- `amr` method). A Custom Access Token hook may drop both claims (its schema lists them as optional), and then only
-- the session itself tells the OAuth session apart: Supabase Auth (v2.197.0, the version compose pins) binds it to
-- the client in auth.sessions.oauth_client_id. In db mode the kernel reads that row on every request anyway.
--
-- auth_session_oauth_bound()  new Supabase Auth reader, owned by crove_auth_reader like the others: true when the
--                             session row names an OAuth client. Reads only id and oauth_client_id. Guarded on the
--                             column existing: an older Supabase Auth without the OAuth server has no such column and
--                             no such session, so it answers false there and the check keeps working.
-- auth_grants_ready()         also requires the reader's SELECT on auth.sessions.oauth_client_id when the column
--                             exists, so a Supabase Auth upgrade that adds it answers 503 AUTH_NOT_READY (55000
--                             AUTH_GRANTS_MISSING) until `auth-grants` ran again, instead of a permission error or a
--                             silently skipped check; and requires the column itself wherever Supabase Auth has the
--                             OAuth server (auth.oauth_clients), where its absence would leave the check blind.
--                             Upgrading Crove on a Supabase Auth that has the column therefore needs `auth-grants`
--                             once more (compose runs it on every `up`).
-- session_check()             raises OAUTH_CLIENT_SESSION (28000, answered 401 OAUTH_CLIENT_TOKEN_REFUSED) for such a
-- identity_resolve()          session in db mode, right after the session is found valid upstream and before the MFA
--                             rule, any Crove session record or a new user account is written.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Supabase Auth reader: is this session bound to an OAuth client? PL/pgSQL, so the body is not resolved before
-- Supabase Auth has created its tables, and the column is read only once it is known to exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.auth_session_oauth_bound(p_session_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pg_catalog.to_regclass('auth.sessions') AND a.attname = 'oauth_client_id'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = p_session_id AND s.oauth_client_id IS NOT NULL);
END $$;

-- ---------------------------------------------------------------------------
-- Readiness: as 20261017004500, plus auth.sessions.oauth_client_id when (and only when) Supabase Auth has it.
-- ---------------------------------------------------------------------------
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
  -- Optional: Supabase Auth releases without the OAuth server have no oauth_client_id. When the column exists the
  -- reader must be able to select it, or the OAuth session check could not run. Two steps, because
  -- has_column_privilege() raises 42703 for a missing column and SQL does not promise left-to-right AND. Where
  -- the OAuth server exists (auth.oauth_clients) but the column does not (a release that renamed or dropped it,
  -- or one from before sessions were bound to their client), OAuth sessions cannot be told apart: not ready.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = pg_catalog.to_regclass('auth.sessions') AND a.attname = 'oauth_client_id'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    IF NOT pg_catalog.has_column_privilege('crove_auth_reader', pg_catalog.to_regclass('auth.sessions'), 'oauth_client_id', 'SELECT') THEN
      RETURN false;
    END IF;
  ELSIF pg_catalog.to_regclass('auth.oauth_clients') IS NOT NULL THEN
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
--   28000 OAUTH_CLIENT_SESSION              -> 401 OAUTH_CLIENT_TOKEN_REFUSED (session bound to an OAuth client; db mode)
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
    -- Also false when auth.mfa_factors is missing (the MFA rule below is never skipped), or when the reader may not
    -- select auth.sessions.oauth_client_id although the column exists (the OAuth rule is never skipped either).
    IF NOT crove_kernel.auth_grants_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF v_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT crove_kernel.auth_session_valid(p_session_id, v_subject::uuid) THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    -- A session Supabase Auth's OAuth server created for a third-party client, whatever claims its token carries
    -- (issue #276): a browser never holds one. Before the MFA rule, so the SPA signs out instead of asking for MFA.
    IF crove_kernel.auth_session_oauth_bound(p_session_id) THEN
      RAISE EXCEPTION 'OAUTH_CLIENT_SESSION' USING ERRCODE = '28000';
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

-- Maps a verified access token to its Crove user, after the same checks as session_check (minus the org), so a
-- disabled user or a revoked, signed-out, banned, deleted or OAuth-bound session never creates or updates the account.
CREATE OR REPLACE FUNCTION crove_kernel.identity_resolve(
  p_issuer text, p_subject text, p_email text, p_name text, p_session_id uuid, p_upstream boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_disabled timestamptz;
BEGIN
  IF p_session_id IS NULL OR p_upstream IS NULL THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  SELECT u.id, u.disabled_at INTO v_id, v_disabled
  FROM crove_kernel.user_account u WHERE u.issuer = p_issuer AND u.subject = p_subject;
  IF FOUND THEN
    IF v_disabled IS NOT NULL THEN
      RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM crove_kernel.auth_session s
      WHERE s.user_id = v_id AND s.session_id = p_session_id AND s.status = 'revoked'
    ) THEN
      RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '28000';
    END IF;
  END IF;
  IF p_upstream THEN
    IF NOT crove_kernel.auth_grants_ready() THEN
      RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
    END IF;
    IF p_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT crove_kernel.auth_session_valid(p_session_id, p_subject::uuid) THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    IF crove_kernel.auth_session_oauth_bound(p_session_id) THEN
      RAISE EXCEPTION 'OAUTH_CLIENT_SESSION' USING ERRCODE = '28000';
    END IF;
  END IF;
  RETURN crove_kernel.identity_upsert(p_issuer, p_subject, p_email, p_name);
END $$;

-- ---------------------------------------------------------------------------
-- Ownership: like auth_session_valid, the reader belongs to crove_auth_reader (see 20261015090000).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_auth_reader TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_kernel TO crove_auth_reader;
ALTER FUNCTION crove_kernel.auth_session_oauth_bound(uuid) OWNER TO crove_auth_reader;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_auth_reader;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix, restated: only the API login role runs the checks; the readers are reachable only through them.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.auth_session_oauth_bound(uuid),
  crove_kernel.auth_grants_ready(),
  crove_kernel.session_check(uuid, uuid, boolean, uuid, text),
  crove_kernel.identity_resolve(text, text, text, text, uuid, boolean)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  crove_kernel.auth_grants_ready(),
  crove_kernel.session_check(uuid, uuid, boolean, uuid, text),
  crove_kernel.identity_resolve(text, text, text, text, uuid, boolean)
TO crove_app;
