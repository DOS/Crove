-- Identity sessions and revocation (ADR-0028, design C; External-tenant gate T1). Idempotent; applied files stay
-- untouched.
--
-- auth_session              Crove-owned session status record, keyed by (user_id, session_id). A revoked row
--                           rejects every token of that session, refreshed or not: a refresh keeps the session_id.
-- user_account.disabled_at  blocks a user in Crove without touching Supabase Auth (403).
-- crove_auth_reader         NOLOGIN owner of the definers that read Supabase Auth's auth.sessions and auth.users on
--                           self-host (AUTH_SESSION_CHECK=db). Its SELECT on exactly those columns (and a SELECT
--                           policy, as Supabase Auth enables row-level security) is applied by the one-shot
--                           `auth-grants` step after Supabase Auth has created its tables, never here: the tables do
--                           not exist yet when `migrate` runs on a fresh install.
-- auth_session_org          a session revoked by an org owner for one member: it blocks that session in that org only.
--                           Sessions are global per user and membership is added without the member's consent, so
--                           nobody but the user (and later staff) may revoke globally or sign a session out upstream.
-- session_check()           runs in the request transaction, before enter_context: disabled user, revoked record, the
--                           org-scoped record for the org in context and, in db mode, the upstream session and user
--                           state. Fails closed.
-- identity_resolve()        maps a verified token to its user only after the same checks pass, so a revoked or disabled
--                           session never updates the account's email or name.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crove_auth_reader') THEN
    CREATE ROLE crove_auth_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  -- Drift guard: the reader only ever reads two Supabase Auth tables.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'crove_auth_reader' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION 'role crove_auth_reader must be NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;
END $$;

ALTER TABLE crove_kernel.user_account ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

-- ---------------------------------------------------------------------------
-- Session status record (global machinery table, no org_id). Only the definers below touch it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.auth_session (
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Updated at most once a minute, never on every request.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES crove_kernel.user_account (id),
  reason text CHECK (length(reason) <= 500),
  -- Crove Cloud (events adapter): time of the newest proof that the session was valid.
  evidence_at timestamptz,
  PRIMARY KEY (user_id, session_id),
  CONSTRAINT auth_session_revoked_at CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
REVOKE ALL ON crove_kernel.auth_session FROM PUBLIC;
ALTER TABLE crove_kernel.auth_session ENABLE ROW LEVEL SECURITY;

-- A revoked session stays revoked: nothing turns it back to active or rewrites when it was revoked.
CREATE OR REPLACE FUNCTION crove_kernel.auth_session_keep_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked' OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'session % stays revoked', OLD.session_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_revoked ON crove_kernel.auth_session;
CREATE TRIGGER keep_revoked BEFORE UPDATE ON crove_kernel.auth_session
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.auth_session_keep_revoked();

-- Sessions seen in an org, and their revocation by the org owner for that org only. Machinery table: only the
-- definers below touch it (no grants, row-level security on, no policies).
CREATE TABLE IF NOT EXISTS crove_kernel.auth_session_org (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES crove_kernel.user_account (id),
  session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES crove_kernel.user_account (id),
  reason text CHECK (length(reason) <= 500),
  PRIMARY KEY (org_id, user_id, session_id),
  CONSTRAINT auth_session_org_revoked_at CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
REVOKE ALL ON crove_kernel.auth_session_org FROM PUBLIC;
ALTER TABLE crove_kernel.auth_session_org ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS keep_revoked ON crove_kernel.auth_session_org;
CREATE TRIGGER keep_revoked BEFORE UPDATE ON crove_kernel.auth_session_org
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.auth_session_keep_revoked();

-- ---------------------------------------------------------------------------
-- Self-host upstream status (AUTH_SESSION_CHECK=db). PL/pgSQL, so the bodies are not resolved before Supabase
-- Auth has created its tables.
-- ---------------------------------------------------------------------------
-- Valid means: the session row exists for that user, its not_after (when set) is in the future, and the user
-- exists, is not soft-deleted and is not banned.
CREATE OR REPLACE FUNCTION crove_kernel.auth_session_valid(p_session_id uuid, p_subject uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM auth.sessions s
    JOIN auth.users u ON u.id = s.user_id
    WHERE s.id = p_session_id
      AND s.user_id = p_subject
      AND (s.not_after IS NULL OR s.not_after > pg_catalog.now())
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.now())
  );
END $$;

-- Every upstream session of a user ("revoke all sessions").
CREATE OR REPLACE FUNCTION crove_kernel.auth_user_sessions(p_subject uuid)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT s.id FROM auth.sessions s WHERE s.user_id = p_subject;
END $$;

-- True once `auth-grants` has run: both tables exist, the reader may select every column the check reads and,
-- where Supabase Auth turned on row-level security, a SELECT policy lets the reader see rows. A Supabase Auth
-- schema change that drops a column makes it false, so the check fails closed with 503 instead of 401 for all.
CREATE OR REPLACE FUNCTION crove_kernel.auth_grants_ready()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.to_regnamespace('auth') IS NULL
     OR pg_catalog.to_regclass('auth.sessions') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL THEN
    RETURN false;
  END IF;
  IF NOT pg_catalog.has_schema_privilege('crove_auth_reader', 'auth', 'USAGE') THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid IN (pg_catalog.to_regclass('auth.sessions'), pg_catalog.to_regclass('auth.users'))
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
                 ('auth.users', 'id'), ('auth.users', 'banned_until'), ('auth.users', 'deleted_at')) AS c (tbl, col)
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
--   42501 USER_DISABLED                     -> 403
--   55000 AUTH_GRANTS_MISSING               -> 503 (`auth-grants` has not run)
-- p_upstream = true is the self-host db adapter; false checks the Crove records and user state only.
-- p_org_id is the org in context (NULL for org-less work): a session its owner revoked for this member is refused
-- there, and a session first seen there by a member is recorded for that org's owner to see.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.session_check(p_user_id uuid, p_session_id uuid, p_upstream boolean, p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_subject text;
  v_disabled timestamptz;
  v_status text;
  v_seen timestamptz;
  v_org_status text;
  v_org_seen timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR p_upstream IS NULL THEN
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
-- disabled user or a revoked, signed-out, banned or deleted session never creates or updates the account.
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
  END IF;
  RETURN crove_kernel.identity_upsert(p_issuer, p_subject, p_email, p_name);
END $$;

-- Who may see and revoke a user's sessions (ADR-0028 section 4): the user themself (true), or the owner of the
-- org in context for a member of that org (false: org-scoped). Raises 42501 for everyone else, admins included.
CREATE OR REPLACE FUNCTION crove_kernel.session_manage_check(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := crove_kernel.ctx_user_id();
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = v_actor THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_actor AND m.role = 'owner')
     AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user_id) THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'SESSION_MANAGE_FORBIDDEN' USING ERRCODE = '42501';
END $$;

-- The user's own sessions as Crove has seen them; for an owner, only the member's sessions seen in that org and
-- their status there, never activity from other orgs. Newest first.
CREATE OR REPLACE FUNCTION crove_kernel.session_list(p_user_id uuid)
RETURNS TABLE (session_id uuid, status text, first_seen_at timestamptz, last_seen_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.session_manage_check(p_user_id) THEN
    RETURN QUERY
    SELECT s.session_id, s.status, s.first_seen_at, s.last_seen_at, s.revoked_at
    FROM crove_kernel.auth_session s
    WHERE s.user_id = p_user_id
    ORDER BY s.first_seen_at DESC
    LIMIT 200;
  ELSE
    RETURN QUERY
    SELECT o.session_id, o.status, o.first_seen_at, o.last_seen_at, o.revoked_at
    FROM crove_kernel.auth_session_org o
    WHERE o.org_id = crove_kernel.ctx_org_id() AND o.user_id = p_user_id
    ORDER BY o.first_seen_at DESC
    LIMIT 200;
  END IF;
END $$;

-- Revokes one session (p_session_id) or every session (p_session_id NULL), effective on the next request.
--   The user themself: global. "Every session" covers the sessions Crove has seen and, on self-host after
--   `auth-grants`, every upstream session. sign_out names the Supabase Auth sign-out to run, only for a session that
--   belongs to the user (in auth.sessions for their subject, or seen by Crove with a verified token when the
--   upstream tables are not readable): 'local' for one session, 'global' once for "every session".
--   An org owner for a member: that org only. "Every session" covers the member's sessions seen in that org. No
--   global record and no upstream sign-out: the member keeps access to their other orgs.
CREATE OR REPLACE FUNCTION crove_kernel.session_revoke(p_user_id uuid, p_session_id uuid, p_reason text)
RETURNS TABLE (revoked_session uuid, auth_subject text, sign_out text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := crove_kernel.ctx_user_id();
  v_org uuid := crove_kernel.ctx_org_id();
  v_subject text;
  v_targets uuid[];
  v_owned uuid[];
  v_global_sent boolean := false;
  v_id uuid;
BEGIN
  IF NOT crove_kernel.session_manage_check(p_user_id) THEN
    IF p_session_id IS NOT NULL THEN
      v_targets := ARRAY[p_session_id];
    ELSE
      SELECT coalesce(pg_catalog.array_agg(o.session_id), '{}') INTO v_targets
      FROM crove_kernel.auth_session_org o WHERE o.org_id = v_org AND o.user_id = p_user_id AND o.status = 'active';
    END IF;
    FOR v_id IN SELECT DISTINCT t FROM pg_catalog.unnest(v_targets) t LOOP
      INSERT INTO crove_kernel.auth_session_org AS o (org_id, user_id, session_id, status, revoked_at, revoked_by, reason)
      VALUES (v_org, p_user_id, v_id, 'revoked', pg_catalog.now(), v_actor, p_reason)
      ON CONFLICT (org_id, user_id, session_id) DO UPDATE
        SET status = 'revoked',
            revoked_at = coalesce(o.revoked_at, excluded.revoked_at),
            revoked_by = coalesce(o.revoked_by, excluded.revoked_by),
            reason = coalesce(o.reason, excluded.reason);
      revoked_session := v_id;
      auth_subject := NULL;
      sign_out := NULL;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  SELECT u.subject INTO v_subject FROM crove_kernel.user_account u WHERE u.id = p_user_id;
  IF v_subject ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND crove_kernel.auth_grants_ready() THEN
    v_owned := ARRAY(SELECT crove_kernel.auth_user_sessions(v_subject::uuid));
  ELSE
    v_owned := ARRAY(SELECT s.session_id FROM crove_kernel.auth_session s WHERE s.user_id = p_user_id AND s.status = 'active');
  END IF;
  IF p_session_id IS NOT NULL THEN
    v_targets := ARRAY[p_session_id];
  ELSE
    v_targets := ARRAY(SELECT s.session_id FROM crove_kernel.auth_session s WHERE s.user_id = p_user_id AND s.status = 'active')
      || v_owned;
  END IF;
  FOR v_id IN SELECT DISTINCT t FROM pg_catalog.unnest(v_targets) t LOOP
    INSERT INTO crove_kernel.auth_session AS s (user_id, session_id, status, revoked_at, revoked_by, reason)
    VALUES (p_user_id, v_id, 'revoked', pg_catalog.now(), v_actor, p_reason)
    ON CONFLICT (user_id, session_id) DO UPDATE
      SET status = 'revoked',
          revoked_at = coalesce(s.revoked_at, excluded.revoked_at),
          revoked_by = coalesce(s.revoked_by, excluded.revoked_by),
          reason = coalesce(s.reason, excluded.reason);
    revoked_session := v_id;
    auth_subject := v_subject;
    sign_out := CASE
      WHEN NOT (v_id = ANY (v_owned)) THEN NULL
      WHEN p_session_id IS NOT NULL THEN 'local'
      WHEN NOT v_global_sent THEN 'global'
    END;
    IF sign_out = 'global' THEN
      v_global_sent := true;
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Ownership: the upstream readers belong to crove_auth_reader, so they can read nothing but what `auth-grants`
-- gives it. A runner that is not a superuser may only hand a function to a role it can SET ROLE to, and the new
-- owner needs CREATE on the schema while the ownership moves; that CREATE is revoked right after.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_auth_reader TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;
GRANT CREATE ON SCHEMA crove_kernel TO crove_auth_reader;
ALTER FUNCTION crove_kernel.auth_session_valid(uuid, uuid) OWNER TO crove_auth_reader;
ALTER FUNCTION crove_kernel.auth_user_sessions(uuid) OWNER TO crove_auth_reader;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_auth_reader;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix: only the API login role checks and manages sessions.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.auth_session_keep_revoked(),
  crove_kernel.auth_session_valid(uuid, uuid),
  crove_kernel.auth_user_sessions(uuid),
  crove_kernel.auth_grants_ready(),
  crove_kernel.session_check(uuid, uuid, boolean, uuid),
  crove_kernel.identity_resolve(text, text, text, text, uuid, boolean),
  crove_kernel.session_manage_check(uuid),
  crove_kernel.session_list(uuid),
  crove_kernel.session_revoke(uuid, uuid, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  crove_kernel.auth_grants_ready(),
  crove_kernel.session_check(uuid, uuid, boolean, uuid),
  crove_kernel.identity_resolve(text, text, text, text, uuid, boolean),
  crove_kernel.session_list(uuid),
  crove_kernel.session_revoke(uuid, uuid, text)
TO crove_app;
