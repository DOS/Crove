-- Context re-entry guard (plan §4.5 item 1; External-tenant gate T10). Idempotent; applied files stay untouched.
--
-- Before: enter_context and enter_system_context could be called again in the same transaction, so a caller
-- holding one context could switch to another org or actor halfway through a command.
--
-- After: both definers start with context_reentry_guard(), which raises CONTEXT_REENTRY (42501) when this
-- transaction already entered a context, then takes the marker that says it has.
--
-- The marker is a transaction-level advisory lock on (namespace, pg_backend_pid()). Advisory locks are re-entrant
-- within a session, so taking the lock alone never blocks a second entry; the guard first looks the lock up in
-- pg_locks and refuses when this backend already holds it, at any level. A transaction-level lock has no unlock
-- call (pg_advisory_unlock and pg_advisory_unlock_all release session-level locks only), lasts until the
-- transaction ends and works in READ ONLY transactions, which a marker table could not. ROLLBACK TO SAVEPOINT
-- releases a lock taken after the savepoint together with the settings, so the next call is a clean first entry.
-- The key holds the backend pid, so two sessions never contend; a session-level lock on the same key, or the key
-- held by another backend, makes the guard refuse (fail closed) instead of waiting.
--
-- Defense in depth until the context is sealed (T11): the guard also refuses when crove.org_id or crove.user_id is
-- already set. That check alone would not hold, since a login role can reset any custom setting with set_config.

-- Namespace of the context lock: 0x43524F56, 'CROV' in ASCII. Two int4 keys appear in pg_locks as
-- classid = namespace, objid = pid, objsubid = 2, so they never collide with the single bigint keys of the
-- migration runner or pg-boss (objsubid = 1).
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
  IF nullif(pg_catalog.current_setting('crove.org_id', true), '') IS NOT NULL
     OR nullif(pg_catalog.current_setting('crove.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(c_namespace, v_pid) THEN
    RAISE EXCEPTION 'CONTEXT_REENTRY' USING ERRCODE = '42501';
  END IF;
END $$;

-- Same contract as the bootstrap version, plus the guard. CREATE OR REPLACE keeps owner and ACL (crove_app only).
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
  PERFORM pg_catalog.set_config('crove.org_id', p_org_id::text, true);
  PERFORM pg_catalog.set_config('crove.user_id', p_user_id::text, true);
  RETURN v_role;
END $$;

-- Same contract as the T5 version (session_user binding), plus the guard. Owner and ACL (crove_worker only) kept.
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
  PERFORM pg_catalog.set_config('crove.org_id', p_org_id::text, true);
  PERFORM pg_catalog.set_config('crove.user_id', '', true);
END $$;

-- The guard runs only inside the two definers, as their owner; no login role calls it directly.
REVOKE ALL ON FUNCTION crove_kernel.context_reentry_guard() FROM PUBLIC;
