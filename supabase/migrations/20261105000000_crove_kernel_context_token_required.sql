-- Context tokens, step 2 of 2 (#1822, ADR-0028 section 9). Step 1 (20261104230000) gave crove_app
-- enter_user_context, which enters a user's context only from a token the kernel signs with the deployment's key, and
-- kept enter_context for kernels without a key. This step:
--
-- 1. Revokes enter_context from crove_app. Raw SQL on the API's login (an injection, a leaked credential) can no
--    longer name the user it acts as: every user context is entered from a token. enter_context stays, called by
--    enter_user_context alone (as its owner); it is not dropped.
-- 2. Takes the session check the kernel ran into the token (v2), and checks the session in the database too (design
--    step 4): a session a token names must be recorded in crove_kernel.auth_session and active (the kernel's
--    session_check records it in the same transaction), and with the db check also live in Supabase Auth
--    (auth_session_valid). A token of the jwt or db check names its session; one of no check (a runtime without a
--    session source: tests and tools) names none.
--
-- v1 tokens (step 1's kernels) are still accepted, as tokens of no check, for a deploy's restarts and a rollback to
-- step 1: only the key makes either.

SET LOCAL lock_timeout = '2s';

-- Enters a user's context from a token the kernel signed:
--   v2.<user>.<session|->.<org>.<aal1|aal2>.<mfa epoch|->.<db|jwt|off|->.<exp epoch>.<hmac-sha256 hex>
--   v1.<user>.<session|->.<org>.<aal1|aal2>.<mfa epoch|->.<exp epoch>.<hmac-sha256 hex>   (no check)
-- The signature covers everything before the last dot, and is checked first. Then, as in step 1: the org the token
-- was made for, its expiry against this database's clock (refused once past it, or more than 90 seconds ahead), a
-- session revoked for good or in this org. New in step 2: a named session must be recorded and active
-- (SESSION_INVALID otherwise); the db and jwt checks must name one; the db check needs it live in Supabase Auth.
-- Everything else is enter_context's: membership, the org's state, the legal entity scope, the re-entry guard, the
-- seal.
CREATE OR REPLACE FUNCTION crove_kernel.enter_user_context(p_org_id uuid, p_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_parts text[];
  v_user uuid;
  v_session uuid;
  v_check text;
  v_status text;
  v_subject text;
  v_exp timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_org_id IS NULL OR p_token IS NULL OR pg_catalog.length(p_token) > 400 THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_INVALID' USING ERRCODE = '42501';
  END IF;
  -- One pattern for both versions: the check field is present exactly in v2.
  v_parts := pg_catalog.regexp_match(p_token,
    '^(v1|v2)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(aal1|aal2)\.([0-9]{1,12}|-)\.(?:(db|jwt|off|-)\.)?([0-9]{1,12})\.([0-9a-f]{64})$');
  IF v_parts IS NULL
     OR (v_parts[1] = 'v2') <> (v_parts[7] IS NOT NULL)
     OR NOT crove_kernel.context_token_signed(pg_catalog.substr(p_token, 1, pg_catalog.length(p_token) - 65), v_parts[9], true) THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_INVALID' USING ERRCODE = '42501';
  END IF;
  IF v_parts[4]::uuid <> p_org_id THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_ORG' USING ERRCODE = '42501';
  END IF;
  v_exp := pg_catalog.to_timestamp(v_parts[8]::bigint);
  IF v_now > v_exp OR v_exp > v_now + interval '90 seconds' THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_EXPIRED' USING ERRCODE = '42501';
  END IF;
  v_user := v_parts[2]::uuid;
  v_check := coalesce(v_parts[7], '-');
  IF v_check <> '-' AND v_parts[3] = '-' THEN
    RAISE EXCEPTION 'CONTEXT_TOKEN_INVALID' USING ERRCODE = '42501';
  END IF;
  IF v_parts[3] <> '-' THEN
    v_session := v_parts[3]::uuid;
    SELECT s.status INTO v_status FROM crove_kernel.auth_session s WHERE s.user_id = v_user AND s.session_id = v_session;
    IF v_status = 'revoked' THEN
      RAISE EXCEPTION 'SESSION_REVOKED' USING ERRCODE = '28000';
    END IF;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM crove_kernel.auth_session_org o
      WHERE o.org_id = p_org_id AND o.user_id = v_user AND o.session_id = v_session AND o.status = 'revoked'
    ) THEN
      RAISE EXCEPTION 'SESSION_REVOKED_IN_ORG' USING ERRCODE = '28000';
    END IF;
    IF v_check = 'db' THEN
      IF NOT crove_kernel.auth_grants_ready() THEN
        RAISE EXCEPTION 'AUTH_GRANTS_MISSING' USING ERRCODE = '55000';
      END IF;
      SELECT u.subject INTO v_subject FROM crove_kernel.user_account u WHERE u.id = v_user;
      IF v_subject IS NULL
         OR v_subject !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         OR NOT crove_kernel.auth_session_valid(v_session, v_subject::uuid) THEN
        RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
      END IF;
    END IF;
  END IF;
  RETURN crove_kernel.enter_context(v_user, p_org_id);
END $$;

REVOKE ALL ON FUNCTION crove_kernel.enter_user_context(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_user_context(uuid, text) TO crove_app;

-- The API's login enters a user's context only from a token from now on.
REVOKE EXECUTE ON FUNCTION crove_kernel.enter_context(uuid, uuid) FROM crove_app;
