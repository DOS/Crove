-- Context tokens (#1822, ADR-0028 section 9): enter_context took the user it seals from its caller, the crove_app
-- login, and checked only membership, so raw SQL on that login (an injection, a leaked credential) could seal a
-- context as any member. enter_user_context takes a token the kernel signs with a deployment key instead: the user,
-- session, org, assurance level and MFA time come from the token, which raw SQL cannot make without the key.
--
-- The key: 32 to 64 bytes from CROVE_CONTEXT_TOKEN_KEY, installed by the migration runner through
-- context_token_key_install (a bind parameter, never a statement literal), held here as its HMAC pads in a table no
-- login role reads. A rotation keeps exactly one previous key; tokens live 60 seconds, so those signed with it stop
-- verifying soon after.
--
-- Step 1 of 2 (AGENTS.md, changing an invariant on purpose): enter_context stays granted to crove_app, and the
-- runtime uses enter_user_context once the kernel has a key. Step 2 revokes enter_context from crove_app.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The key (definer-only, no org)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.context_token_key (
  slot text PRIMARY KEY CHECK (slot IN ('current', 'previous')),
  -- key XOR 0x36 and key XOR 0x5c over the 64-byte SHA-256 block (RFC 2104).
  k_ipad bytea NOT NULL CHECK (pg_catalog.length(k_ipad) = 64),
  k_opad bytea NOT NULL CHECK (pg_catalog.length(k_opad) = 64),
  installed_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
REVOKE ALL ON crove_kernel.context_token_key FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.context_token_key FROM %I', r.rolname);
  END LOOP;
END $$;
ALTER TABLE crove_kernel.context_token_key ENABLE ROW LEVEL SECURITY;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.context_token_key');

-- Installs the deployment's key, keeping the one it replaces as the previous key (and dropping an older one).
-- Answers 'unchanged' when the key is already the current one. Run by the migration runner only (no login role may).
CREATE OR REPLACE FUNCTION crove_kernel.context_token_key_install(p_key bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key bytea;
  v_ipad bytea;
  v_opad bytea;
  i int;
BEGIN
  IF p_key IS NULL OR pg_catalog.length(p_key) < 32 OR pg_catalog.length(p_key) > 64 THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_KEY_LENGTH' USING ERRCODE = '22023';
  END IF;
  v_key := p_key || pg_catalog.decode(pg_catalog.repeat('00', 64 - pg_catalog.length(p_key)), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  FOR i IN 0..63 LOOP
    v_ipad := pg_catalog.set_byte(v_ipad, i, pg_catalog.get_byte(v_key, i) # 54);
    v_opad := pg_catalog.set_byte(v_opad, i, pg_catalog.get_byte(v_key, i) # 92);
  END LOOP;
  IF EXISTS (SELECT 1 FROM crove_kernel.context_token_key k WHERE k.slot = 'current' AND k.k_ipad = v_ipad AND k.k_opad = v_opad) THEN
    RETURN 'unchanged';
  END IF;
  DELETE FROM crove_kernel.context_token_key WHERE slot = 'previous';
  UPDATE crove_kernel.context_token_key SET slot = 'previous' WHERE slot = 'current';
  INSERT INTO crove_kernel.context_token_key (slot, k_ipad, k_opad) VALUES ('current', v_ipad, v_opad);
  RETURN 'installed';
END $$;

-- Whether a token's signature verifies under the current or the previous key. Both are always computed and the
-- comparison runs over every byte, so the time taken does not tell how much of a signature matched.
CREATE OR REPLACE FUNCTION crove_kernel.context_token_signed(p_message text, p_signature text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_given bytea;
  v_expected bytea;
  v_ok boolean := false;
  v_diff int;
  r record;
  i int;
BEGIN
  IF p_message IS NULL OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  v_given := pg_catalog.decode(p_signature, 'hex');
  FOR r IN SELECT k.k_ipad, k.k_opad FROM crove_kernel.context_token_key k LOOP
    v_expected := pg_catalog.sha256(r.k_opad || pg_catalog.sha256(r.k_ipad || pg_catalog.convert_to(p_message, 'UTF8')));
    v_diff := 0;
    FOR i IN 0..31 LOOP
      v_diff := v_diff | (pg_catalog.get_byte(v_given, i) # pg_catalog.get_byte(v_expected, i));
    END LOOP;
    v_ok := v_ok OR v_diff = 0;
  END LOOP;
  RETURN v_ok;
END $$;

-- Whether a token's signature verifies, for the kernel's boot check that its key is the database's (no context, no
-- expiry check): it answers only true or false, so it gives away nothing about the key.
CREATE OR REPLACE FUNCTION crove_kernel.context_token_valid(p_token text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cut int;
BEGIN
  IF p_token IS NULL OR pg_catalog.length(p_token) > 400 THEN
    RETURN false;
  END IF;
  v_cut := pg_catalog.length(p_token) - 64;
  IF v_cut < 2 OR pg_catalog.substr(p_token, v_cut, 1) <> '.' THEN
    RETURN false;
  END IF;
  RETURN crove_kernel.context_token_signed(pg_catalog.substr(p_token, 1, v_cut - 1), pg_catalog.substr(p_token, v_cut + 1));
END $$;

-- Enters a user's context from a token the kernel signed (ADR-0028 section 9):
--   v1.<user>.<session|->.<org>.<aal1|aal2>.<mfa epoch|->.<exp epoch>.<hmac-sha256 hex>
-- The signature covers everything before the last dot. The token names the org it was made for, so it enters no
-- other. exp is the kernel's clock plus 60 seconds and is checked against this database's clock with 30 seconds
-- either way for skew: refused once the database's clock is 30 seconds past exp, and when exp lies more than 90
-- seconds ahead of it. A session the token names that is revoked (for good, or in this org) is refused. Everything
-- else is enter_context's: membership, the org's state, the legal entity scope, the re-entry guard, the seal.
CREATE OR REPLACE FUNCTION crove_kernel.enter_user_context(p_org_id uuid, p_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_parts text[];
  v_user uuid;
  v_session uuid;
  v_exp timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_org_id IS NULL OR p_token IS NULL OR pg_catalog.length(p_token) > 400 THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_INVALID' USING ERRCODE = '42501';
  END IF;
  v_parts := pg_catalog.regexp_match(p_token,
    '^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(aal1|aal2)\.([0-9]{1,12}|-)\.([0-9]{1,12})\.([0-9a-f]{64})$');
  IF v_parts IS NULL
     OR NOT crove_kernel.context_token_signed(pg_catalog.substr(p_token, 1, pg_catalog.length(p_token) - 65), v_parts[7]) THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_INVALID' USING ERRCODE = '42501';
  END IF;
  IF v_parts[3]::uuid <> p_org_id THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_ORG' USING ERRCODE = '42501';
  END IF;
  v_exp := pg_catalog.to_timestamp(v_parts[6]::bigint);
  IF v_now > v_exp + interval '30 seconds' OR v_exp > v_now + interval '90 seconds' THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_EXPIRED' USING ERRCODE = '42501';
  END IF;
  v_user := v_parts[1]::uuid;
  IF v_parts[2] <> '-' THEN
    v_session := v_parts[2]::uuid;
    IF EXISTS (SELECT 1 FROM crove_kernel.auth_session s WHERE s.user_id = v_user AND s.session_id = v_session AND s.status = 'revoked') THEN
      RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '28000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM crove_kernel.auth_session_org o
      WHERE o.org_id = p_org_id AND o.user_id = v_user AND o.session_id = v_session AND o.status = 'revoked'
    ) THEN
      RAISE EXCEPTION 'SESSION_REVOKED_IN_ORG' USING ERRCODE = '28000';
    END IF;
  END IF;
  RETURN crove_kernel.enter_context(v_user, p_org_id);
END $$;

REVOKE ALL ON FUNCTION
  crove_kernel.context_token_key_install(bytea),
  crove_kernel.context_token_signed(text, text),
  crove_kernel.context_token_valid(text),
  crove_kernel.enter_user_context(uuid, text)
FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION crove_kernel.context_token_key_install(bytea), crove_kernel.context_token_signed(text, text), '
      'crove_kernel.context_token_valid(text), crove_kernel.enter_user_context(uuid, text) FROM %I', r.rolname);
  END LOOP;
END $$;
-- As enter_context: the API's login alone enters a user's context; the worker enters system and agent contexts.
GRANT EXECUTE ON FUNCTION crove_kernel.enter_user_context(uuid, text), crove_kernel.context_token_valid(text) TO crove_app;
