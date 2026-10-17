-- Single-use OAuth state for connecting channels (Social plan §3.5, step S6.1, issue #370). Idempotent; applied files
-- stay untouched.
--
-- oauth_state  one row per connect attempt: the hash of the `state` parameter sent to the provider, the PKCE
--              verifier, the member who started it and a 10 minute expiry. Definer-only machinery: no Crove role
--              holds a grant on it (the RLS matrix lists it in MACHINERY; its row factory landed first, #361).
--                oauth_state_create   an owner or admin of the org in context starts an attempt;
--                oauth_state_consume  the same member, in the same org, finishes it once: the row is marked used
--                                     and the verifier is wiped in the same statement that hands it out.
-- The state itself never reaches the database, only its SHA-256, so a dump cannot finish someone's attempt.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.oauth_state (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- The member who started the attempt. Not a foreign key, like channel_connection.connected_by: consume checks that
  -- this user is still an owner or admin of the org.
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  state_hash text NOT NULL CHECK (state_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- RFC 7636: 43 to 128 unreserved characters. NULL for providers without PKCE, and after the attempt is consumed.
  code_verifier text CHECK (code_verifier IS NULL OR code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_state_hash_uq ON crove_kernel.oauth_state (state_hash);
CREATE INDEX IF NOT EXISTS oauth_state_open_idx ON crove_kernel.oauth_state (org_id, user_id) WHERE consumed_at IS NULL;
ALTER TABLE crove_kernel.oauth_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crove_kernel.oauth_state FROM PUBLIC, crove_tenant, crove_app, crove_worker;

-- Starts a connect attempt for the member and org in context; returns its id. Raises NO_CONTEXT (42501) without a
-- user context, OAUTH_FORBIDDEN (42501) for anyone but an owner or admin of the org, OAUTH_INVALID (22023) for a
-- malformed provider, hash, verifier or lifetime (60 to 900 seconds), and OAUTH_TOO_MANY (54000) when the member
-- already has 20 open attempts in the org. Rows older than a day are cleared on the way.
CREATE OR REPLACE FUNCTION crove_kernel.oauth_state_create(p_provider text, p_state_hash text, p_code_verifier text, p_ttl_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'OAUTH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$'
     OR p_state_hash IS NULL OR p_state_hash !~ '^sha256:[0-9a-f]{64}$'
     OR (p_code_verifier IS NOT NULL AND p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'OAUTH_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.oauth_state s WHERE s.org_id = v_org AND s.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT count(*) FROM crove_kernel.oauth_state s
      WHERE s.org_id = v_org AND s.user_id = v_user AND s.consumed_at IS NULL AND s.expires_at > pg_catalog.now()) >= 20 THEN
    RAISE EXCEPTION 'OAUTH_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.oauth_state (org_id, user_id, provider, state_hash, code_verifier, expires_at)
  VALUES (v_org, v_user, p_provider, p_state_hash, p_code_verifier, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Finishes a connect attempt once and hands out its PKCE verifier (NULL when the provider has none). Raises
-- NO_CONTEXT (42501) without a user context, OAUTH_FORBIDDEN (42501) when the member is no longer an owner or admin,
-- OAUTH_STATE_INVALID (P0002) when no attempt matches the hash for this member, org and provider (one answer for all
-- of them, so another org's or member's attempt cannot be told apart from none), and OAUTH_STATE_USED (55000) or
-- OAUTH_STATE_EXPIRED (55000).
CREATE OR REPLACE FUNCTION crove_kernel.oauth_state_consume(p_provider text, p_state_hash text)
RETURNS TABLE (code_verifier text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_row crove_kernel.oauth_state%ROWTYPE;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'OAUTH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM crove_kernel.oauth_state s
  WHERE s.state_hash = p_state_hash AND s.org_id = v_org AND s.user_id = v_user AND s.provider = p_provider
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAUTH_STATE_INVALID' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'OAUTH_STATE_USED' USING ERRCODE = '55000';
  END IF;
  IF v_row.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'OAUTH_STATE_EXPIRED' USING ERRCODE = '55000';
  END IF;
  UPDATE crove_kernel.oauth_state s SET consumed_at = pg_catalog.now(), code_verifier = NULL
  WHERE s.org_id = v_row.org_id AND s.id = v_row.id;
  RETURN QUERY SELECT v_row.code_verifier;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.oauth_state_create(text, text, text, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.oauth_state_consume(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
-- The API starts and finishes attempts for the signed-in member; the worker never takes part in a connect.
GRANT EXECUTE ON FUNCTION crove_kernel.oauth_state_create(text, text, text, integer) TO crove_app;
GRANT EXECUTE ON FUNCTION crove_kernel.oauth_state_consume(text, text) TO crove_app;
