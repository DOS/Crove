-- Sealed request context (plan §1 principle 3, §4.5 item 5; External-tenant gate T11). Idempotent; applied files
-- stay untouched.
--
-- Before: enter_context and enter_system_context stored org and actor in the plain transaction settings
-- crove.org_id and crove.user_id, and the ctx_* helpers returned whatever those settings held. Any role that could
-- run SQL in the transaction (crove_app, crove_worker, a definer body, a compromised or injected query) could call
-- set_config('crove.org_id', <other org>, true), with or without enter_context first, and RLS, emit() and every
-- definer that reads the context would then act for that org.
--
-- After:
--   * The whole context (org, actor kind, user, org role, legal-entity scope, sensitivity flags) is one JSON value
--     in crove.ctx, derived by enter_context / enter_system_context from the database, never from parameters other
--     than the user and org being entered (both checked against tenant_member / tenant; see the residuals below).
--   * crove.ctx_seal = HMAC-SHA256(context_key, 'crove.ctx.v1' | pg_backend_pid() | transaction start in
--     microseconds | crove.ctx), hex. The seal binds the exact stored text, the backend and the transaction, so it
--     cannot be edited, moved to another connection or replayed into a later transaction on the same connection.
--   * ctx_verified() is the one place that checks the seal; every ctx_* helper reads the context only through it.
--     No context at all (both settings empty) means NULL: 0 rows, and WITH CHECK fails. A context or seal that is
--     present but does not verify (forged, edited, replayed, half reset) raises CONTEXT_SEAL_INVALID (42501): the
--     statement fails closed, and the runtime maps it to INTERNAL 500, since it is tampering or a bug, never
--     something the user can act on.
--   * crove.org_id and crove.user_id are no longer set and no longer read. Setting them grants nothing; the
--     re-entry guard still refuses to enter when they are set, as a tamper signal.
--
-- Why an HMAC over settings and not a context table: a READ ONLY transaction cannot write a table, even inside a
-- definer, and queries run READ ONLY (plan §4.4). Transaction settings work there and roll back with savepoints.
-- They are writable by every role, so they need a seal only the definers can produce.
--
-- The key: 32 bytes from SHA-256 over four random UUIDs (gen_random_uuid uses the server's strong random source;
-- 488 random bits in). It lives in crove_kernel.context_key, owned by the migration runner (the owner of the
-- definers), with no grant to any role and row-level security on without a policy, so a grant added by mistake
-- still shows no row. Stored as the HMAC inner and outer padded keys, so a check costs two sha256() calls and no
-- byte loop. HMAC is built from the core sha256() function: no pgcrypto, the schema keeps running on any
-- PostgreSQL 17. The key is never in a function body (pg_proc is readable by everyone) or in a statement text.
-- Rotating it is a new migration that replaces the row; contexts entered before the rotation stop verifying.
--
-- Cost: RLS policies call the helpers as (SELECT ...), so the check runs once per statement per helper: one
-- primary-key lookup of a one-row table and two SHA-256 over about 250 bytes. The verified result is not cached
-- in a setting, because such a cache would itself be a writable setting.
--
-- Accepted residuals (documented in the plan, T11):
--   * Replay needs two transactions of one backend starting in the same microsecond (transaction_timestamp()
--     comes from the system clock; a backward clock step could repeat a value).
--   * ROLLBACK TO SAVEPOINT may bring back a context that enter_context derived earlier in the same transaction,
--     after the re-entry guard was released with that savepoint (T10 accepts the same). Such a context was
--     derived and checked by enter_context, so it grants nothing enter_context would not.
--   * The superuser, the database owner and anyone with a database dump can read the key; they can bypass RLS
--     anyway.
--   * The seal stops forgery through set_config. It does not stop crove_app from calling enter_context for another
--     existing member: the API still names the (user, org) pair it enters, checked only against membership. That
--     trust is bounded separately (actor bound to session_user, §4.5 item 2; ADR-0028 session checks, T1).
--   * transaction_timestamp() needs microsecond clock resolution, which PostgreSQL 17 has on Linux and Windows.

-- ---------------------------------------------------------------------------
-- The key
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.context_key (
  id smallint PRIMARY KEY CHECK (id = 1),
  -- key XOR 0x36 and key XOR 0x5c over the 64-byte SHA-256 block (RFC 2104).
  k_ipad bytea NOT NULL CHECK (pg_catalog.length(k_ipad) = 64),
  k_opad bytea NOT NULL CHECK (pg_catalog.length(k_opad) = 64),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
REVOKE ALL ON crove_kernel.context_key FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.context_key FROM %I', r.rolname);
  END LOOP;
END $$;
ALTER TABLE crove_kernel.context_key ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_key bytea;
  v_ipad bytea;
  v_opad bytea;
  i int;
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.context_key) THEN
    RETURN;
  END IF;
  -- 32-byte key, zero-padded to the 64-byte block as HMAC specifies.
  v_key := pg_catalog.sha256(
             pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
             || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) || pg_catalog.uuid_send(pg_catalog.gen_random_uuid()))
           || pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  FOR i IN 0..63 LOOP
    v_ipad := pg_catalog.set_byte(v_ipad, i, pg_catalog.get_byte(v_key, i) # 54);
    v_opad := pg_catalog.set_byte(v_opad, i, pg_catalog.get_byte(v_key, i) # 92);
  END LOOP;
  INSERT INTO crove_kernel.context_key (id, k_ipad, k_opad) VALUES (1, v_ipad, v_opad);
END $$;

-- ---------------------------------------------------------------------------
-- Seal and check
-- ---------------------------------------------------------------------------
-- HMAC of a context text for this backend and transaction, hex; NULL when the key is missing. Runs only inside the
-- definers below, as their owner: no role is granted EXECUTE, so no caller can seal a context of its choosing.
-- PL/pgSQL rather than SQL so the key lookup keeps a cached plan across calls.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_mac(p_ctx text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
BEGIN
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.context_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'crove.ctx.v1' || pg_catalog.chr(31)
      || pg_catalog.pg_backend_pid()::text || pg_catalog.chr(31)
      || ((extract(epoch FROM pg_catalog.transaction_timestamp()) * 1000000)::bigint)::text
      || pg_catalog.chr(31) || p_ctx,
      'UTF8'))),
    'hex');
END $$;

-- Writes the context and its seal as transaction-local settings. Called only by enter_context and
-- enter_system_context, after their checks.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_write(p_ctx jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_text text := p_ctx::text;
  v_seal text := crove_kernel.ctx_mac(v_text);
BEGIN
  IF v_seal IS NULL THEN
    RAISE EXCEPTION 'CONTEXT_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.set_config('crove.ctx', v_text, true);
  PERFORM pg_catalog.set_config('crove.ctx_seal', v_seal, true);
END $$;

-- The verified context of this transaction, or NULL when none was entered. Raises CONTEXT_SEAL_INVALID when a
-- context or seal is present but does not verify. Every ctx_* helper goes through this function.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_verified()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx text := coalesce(pg_catalog.current_setting('crove.ctx', true), '');
  v_seal text := coalesce(pg_catalog.current_setting('crove.ctx_seal', true), '');
BEGIN
  IF v_ctx = '' AND v_seal = '' THEN
    RETURN NULL;
  END IF;
  IF v_ctx = '' OR v_seal = '' OR v_seal IS DISTINCT FROM crove_kernel.ctx_mac(v_ctx) THEN
    RAISE EXCEPTION 'CONTEXT_SEAL_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN v_ctx::jsonb;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers. Same names and return types as before for org and user; CREATE OR REPLACE keeps owner and ACL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.ctx_org_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (crove_kernel.ctx_verified() ->> 'org')::uuid
$$;

CREATE OR REPLACE FUNCTION crove_kernel.ctx_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT (crove_kernel.ctx_verified() ->> 'user')::uuid
$$;

-- 'user' or 'system'; NULL without a context.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_actor_type() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT crove_kernel.ctx_verified() ->> 'actor'
$$;

-- Legal entities the context may see: explicit ids, or the explicit value '*' for all. NULL without a context,
-- which callers treat as deny, never as "everything".
CREATE OR REPLACE FUNCTION crove_kernel.ctx_le_scope() RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY(SELECT pg_catalog.jsonb_array_elements_text(c -> 'le_scope'))
  FROM (SELECT crove_kernel.ctx_verified() AS c) s
  WHERE pg_catalog.jsonb_typeof(s.c -> 'le_scope') = 'array'
$$;

-- TRUE when the context may see this legal entity; FALSE without a context or scope.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_le_allowed(p_legal_entity_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce('*' = ANY (s.scope) OR p_legal_entity_id::text = ANY (s.scope), false)
  FROM (SELECT crove_kernel.ctx_le_scope() AS scope) s
$$;

-- TRUE when the context carries this sensitivity flag; FALSE without a context.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_has_flag(p_flag text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(c -> 'flags') = 'array' AND pg_catalog.jsonb_exists(c -> 'flags', p_flag), false)
  FROM (SELECT crove_kernel.ctx_verified() AS c) s
$$;

-- ---------------------------------------------------------------------------
-- Re-entry guard (T10) and the entry points
-- ---------------------------------------------------------------------------
-- Same lock logic as the T10 version. It also refuses when the sealed context or its seal is already set (the
-- definer never overwrites a context), and still when the retired crove.org_id or crove.user_id is set.
CREATE OR REPLACE FUNCTION crove_kernel.context_reentry_guard()
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_namespace constant int := 1129467734;
  v_pid int := pg_catalog.pg_backend_pid();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.classid = c_namespace::oid
      AND l.objid = v_pid::oid
      AND l.objsubid = 2
      AND l.pid = v_pid
      AND l.granted
  ) THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
  IF nullif(pg_catalog.current_setting('crove.ctx', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.ctx_seal', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.org_id', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(c_namespace, v_pid) THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
END $$;

-- Same contract as the T10 version; writes the sealed context instead of plain settings. Owner and ACL
-- (crove_app only) kept. Legal entities do not exist yet (§4.6), so every member's scope is the explicit '*',
-- which is what members see today; no sensitivity flags exist yet.
CREATE OR REPLACE FUNCTION crove_kernel.enter_context(p_user_id uuid, p_org_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  SELECT m.role INTO v_role
  FROM crove_kernel.tenant_member m
  JOIN crove_kernel.tenant t ON t.org_id = m.org_id
  WHERE m.org_id = p_org_id AND m.user_id = p_user_id AND t.status = 'active';
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'user',
    'user', p_user_id,
    'role', v_role,
    'le_scope', pg_catalog.jsonb_build_array('*'),
    'flags', '[]'::jsonb));
  RETURN v_role;
END $$;

-- Same contract as the T10 version (worker only, session_user binding); writes the sealed system context.
-- Owner and ACL (crove_worker only) kept.
CREATE OR REPLACE FUNCTION crove_kernel.enter_system_context(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SYSTEM_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant WHERE org_id = p_org_id AND status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'system',
    'user', NULL,
    'role', NULL,
    'le_scope', pg_catalog.jsonb_build_array('*'),
    'flags', '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix. The seal functions run only inside the definers, as their owner. The read helpers are for every
-- tenant role (RLS policies run as the querying role, definers as crove_definer_tenant).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON FUNCTION crove_kernel.ctx_mac(text), crove_kernel.ctx_write(jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.ctx_mac(text), crove_kernel.ctx_write(jsonb) FROM %I', r.rolname);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION
  crove_kernel.ctx_verified(),
  crove_kernel.ctx_actor_type(),
  crove_kernel.ctx_le_scope(),
  crove_kernel.ctx_le_allowed(uuid),
  crove_kernel.ctx_has_flag(text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  crove_kernel.ctx_verified(),
  crove_kernel.ctx_actor_type(),
  crove_kernel.ctx_le_scope(),
  crove_kernel.ctx_le_allowed(uuid),
  crove_kernel.ctx_has_flag(text)
TO crove_tenant;
