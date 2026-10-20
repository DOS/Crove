-- One-character provider ids (#784): X's id is `x`, and every provider pattern asked for two characters at least, so
-- X accounts could neither start the OAuth dialog nor connect. The CHECKs on channel_connection, post_variant and
-- oauth_state and the guard in oauth_state_create now take `^[a-z][a-z0-9_]{0,31}$`, as the mail and snippet tables
-- already do. Only widened: every value that passed before still passes. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t record;
  c record;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('crove_kernel', 'channel_connection'), ('crove_social', 'post_variant'), ('crove_kernel', 'oauth_state')) AS v(schema_name, table_name) LOOP
    -- The old provider CHECK, whatever name it was given.
    FOR c IN
      SELECT con.conname FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = t.schema_name AND rel.relname = t.table_name AND con.contype = 'c'
        AND pg_catalog.pg_get_constraintdef(con.oid) LIKE '%provider%{1,31}%'
    LOOP
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I DROP CONSTRAINT %I', t.schema_name, t.table_name, c.conname);
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = t.schema_name AND rel.relname = t.table_name AND con.conname = t.table_name || '_provider_id_check'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (provider ~ %L)', t.schema_name, t.table_name, t.table_name || '_provider_id_check', '^[a-z][a-z0-9_]{0,31}$');
    END IF;
  END LOOP;
END $$;

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
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{0,31}$'
     OR p_state_hash IS NULL OR p_state_hash !~ '^sha256:[0-9a-f]{64}$'
     OR (p_code_verifier IS NOT NULL AND p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'OAUTH_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.oauth_state s WHERE s.org_id = v_org AND s.created_at < pg_catalog.now() - interval '1 day';
  IF (SELECT count(*) FROM crove_kernel.oauth_state s
      WHERE s.org_id = v_org AND s.user_id = v_user AND s.consumed_at IS NULL AND s.expires_at > pg_catalog.now()
        AND s.created_at > pg_catalog.now() - interval '2 minutes') >= 20 THEN
    RAISE EXCEPTION 'OAUTH_TOO_MANY' USING ERRCODE = '54000';
  END IF;
  INSERT INTO crove_kernel.oauth_state (org_id, user_id, provider, state_hash, code_verifier, expires_at)
  VALUES (v_org, v_user, p_provider, p_state_hash, p_code_verifier, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
