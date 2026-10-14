-- System context is worker-only (External-tenant gate T5, plan §4.5 item 2). Idempotent; applied files stay
-- untouched.
--
-- Before: crove_tenant, and so the API login role crove_app, could execute enter_system_context(org) and
-- enter any active org without a user. Inbound email ran there: the API parsed MIME and executed
-- kernel.inbound.receive as a system actor.
--
-- After:
--   crove_app    enters only as a user (enter_context, which checks membership) and hands inbound email to
--                the worker through inbound_enqueue(), which writes one machinery row and nothing else.
--   crove_worker enters only as the system (enter_system_context), claims inbound mail with inbound_claim()
--                and resolves the org with org_by_inbound_token().
-- enter_system_context also checks session_user, so a definer running as a more privileged owner cannot be
-- used to reach it from an API connection.

-- ---------------------------------------------------------------------------
-- Inbound mail waiting for the worker (global machinery table, no org_id: the org is unknown until the worker
-- parses the message). Only the definers below touch it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.inbound_pending (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  -- Envelope recipient from the mail worker ('' when it sent none); the worker falls back to the headers.
  recipient text NOT NULL DEFAULT '' CHECK (length(recipient) <= 320),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_sha256, recipient)
);
REVOKE ALL ON crove_kernel.inbound_pending FROM PUBLIC;
ALTER TABLE crove_kernel.inbound_pending ENABLE ROW LEVEL SECURITY;

-- Records a raw message the API stored under its sha256, for the worker. Reads nothing and writes no tenant
-- data; a repeated delivery of the same message to the same recipient while it is pending is a no-op.
CREATE OR REPLACE FUNCTION crove_kernel.inbound_enqueue(p_raw_sha256 text, p_size_bytes bigint, p_recipient text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_new boolean;
BEGIN
  INSERT INTO crove_kernel.inbound_pending (raw_sha256, size_bytes, recipient)
  VALUES (p_raw_sha256, p_size_bytes, lower(coalesce(p_recipient, '')))
  ON CONFLICT (raw_sha256, recipient) DO NOTHING;
  v_new := FOUND;
  PERFORM pg_catalog.pg_notify('crove_outbox', '');
  RETURN v_new;
END $$;

-- Claims pending inbound mail for the worker relay (system only).
CREATE OR REPLACE FUNCTION crove_kernel.inbound_claim(p_limit int)
RETURNS TABLE (seq bigint, raw_sha256 text, recipient text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  DELETE FROM crove_kernel.inbound_pending p
  WHERE p.seq IN (
    SELECT q.seq FROM crove_kernel.inbound_pending q ORDER BY q.seq LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  RETURNING p.seq, p.raw_sha256, p.recipient
$$;

-- Same contract as the bootstrap version, plus the session_user binding. CREATE OR REPLACE keeps owner and ACL.
CREATE OR REPLACE FUNCTION crove_kernel.enter_system_context(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SYSTEM_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant WHERE org_id = p_org_id AND status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('crove.org_id', p_org_id::text, true);
  PERFORM pg_catalog.set_config('crove.user_id', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- EXECUTE matrix. Grants to crove_tenant reach both login roles (and crove_definer_tenant), so the
-- role-specific entry points move to the login role that needs them.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  crove_kernel.enter_system_context(uuid),
  crove_kernel.org_by_inbound_token(text),
  crove_kernel.enter_context(uuid, uuid),
  crove_kernel.inbound_enqueue(text, bigint, text),
  crove_kernel.inbound_claim(int)
FROM PUBLIC, crove_tenant, crove_app, crove_worker;

GRANT EXECUTE ON FUNCTION
  crove_kernel.enter_system_context(uuid),
  crove_kernel.org_by_inbound_token(text),
  crove_kernel.inbound_claim(int)
TO crove_worker;

GRANT EXECUTE ON FUNCTION
  crove_kernel.enter_context(uuid, uuid),
  crove_kernel.inbound_enqueue(text, bigint, text)
TO crove_app;
