-- Channel layer: connected social and messaging accounts and their sealed credentials (ADR-0025, Social plan step
-- S2, issue #232). Idempotent; applied files stay untouched.
--
-- channel_connection  one row per connected page or account of an org (Facebook Page, Instagram, Zalo OA, the
--                     offline sandbox...). Tenant data: members read it, commands write it. At most one live (not
--                     revoked) connection per (org, provider, account); reconnecting an account updates its row, so
--                     everything that points at the connection keeps pointing at it.
-- credential          the connection's tokens, sealed by the deployment's credential key (AES-256-GCM envelope,
--                     packages/kernel-runtime/src/vault.ts). The key never reaches the database, so a dump or a backup
--                     holds only ciphertext. Definer-only machinery: no Crove role holds a grant on it.
--                       credential_put   seals in (connect, refresh): owners and admins of the org in context, or
--                                        the system (the worker refreshing a token);
--                       credential_get   reads out: the worker only, in the system context of the org, and only
--                                        while the member who connected the account is still an owner or admin of
--                                        the org and not disabled (plan §7.4);
--                       credential_drop  forgets it (disconnect).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.channel_connection (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  -- The member who connected the account. Not a foreign key: the row outlives the membership, and every use of the
  -- credential checks that this user is still a member (credential_get).
  connected_by uuid NOT NULL,
  -- When the access token expires, if the provider says; NULL when it does not expire on a timer.
  expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_connection_live_uq
  ON crove_kernel.channel_connection (org_id, provider, external_account_id) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS channel_connection_expiry_idx
  ON crove_kernel.channel_connection (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_kernel.channel_connection');
-- A connection is revoked, never deleted: posts and their history keep pointing at it.
REVOKE DELETE ON crove_kernel.channel_connection FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_kernel.credential (
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  -- Which credential key sealed the envelope, for rotation.
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, connection_id),
  CONSTRAINT credential_connection_fk FOREIGN KEY (org_id, connection_id)
    REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE
);
ALTER TABLE crove_kernel.credential ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.credential FROM PUBLIC, crove_tenant, crove_app, crove_worker;

-- Seals in, or replaces, the credential of a live connection of the org in context. Raises NO_CONTEXT (42501)
-- without a context, CREDENTIAL_FORBIDDEN (42501) for an actor that is neither the system nor an owner or admin of
-- the org, and CHANNEL_NOT_FOUND (P0002) when the org has no live connection with that id.
CREATE OR REPLACE FUNCTION crove_kernel.credential_put(p_connection_id uuid, p_key_id text, p_envelope bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND v_actor_type = 'user' AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'CREDENTIAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM crove_kernel.channel_connection c
  WHERE c.org_id = v_org AND c.id = p_connection_id AND c.status <> 'revoked'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHANNEL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO crove_kernel.credential AS k (org_id, connection_id, key_id, envelope)
  VALUES (v_org, p_connection_id, p_key_id, p_envelope)
  ON CONFLICT (org_id, connection_id) DO UPDATE
    SET key_id = EXCLUDED.key_id, envelope = EXCLUDED.envelope, sealed_at = pg_catalog.now();
END $$;

-- The sealed credential of an active connection, for the worker in the system context of its org. Raises
-- NO_CONTEXT (42501) outside a system context, CHANNEL_NOT_FOUND (P0002) when the org has no such connection or it
-- has no credential, CHANNEL_NOT_ACTIVE (55000) when the connection is expired, revoked or in error, and
-- CHANNEL_OWNER_LEFT (42501) when the member who connected it has left the org, is no longer an owner or admin, or is
-- disabled (plan §7.4: the job stops and the connection needs reconnecting by someone who may connect it).
CREATE OR REPLACE FUNCTION crove_kernel.credential_get(p_connection_id uuid)
RETURNS TABLE (key_id text, envelope bytea, provider text, external_account_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_connection crove_kernel.channel_connection%ROWTYPE;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_connection FROM crove_kernel.channel_connection c WHERE c.org_id = v_org AND c.id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHANNEL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_connection.status <> 'active' THEN
    RAISE EXCEPTION 'CHANNEL_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = v_org AND m.user_id = v_connection.connected_by AND m.role IN ('owner', 'admin') AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'CHANNEL_OWNER_LEFT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT k.key_id, k.envelope, v_connection.provider, v_connection.external_account_id
    FROM crove_kernel.credential k WHERE k.org_id = v_org AND k.connection_id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHANNEL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Forgets the credential of a connection of the org in context (disconnect). Same actors as credential_put; a
-- connection without a credential is a no-op.
CREATE OR REPLACE FUNCTION crove_kernel.credential_drop(p_connection_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type IS DISTINCT FROM 'system' AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND v_actor_type = 'user' AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'CREDENTIAL_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.credential k WHERE k.org_id = v_org AND k.connection_id = p_connection_id;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.credential_put(uuid, text, bytea) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.credential_get(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.credential_drop(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_put(uuid, text, bytea) TO crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_drop(uuid) TO crove_app, crove_worker;
-- Reading a credential out is the worker's alone: the API seals tokens in, it never reads them back.
GRANT EXECUTE ON FUNCTION crove_kernel.credential_get(uuid) TO crove_worker;
