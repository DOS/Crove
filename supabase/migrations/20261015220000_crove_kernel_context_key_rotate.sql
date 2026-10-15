-- Rotation of the context key (#117, T11 follow-up; runbook docs/runbooks/context-key-rotation.md). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.context_key_rotate() replaces the one key row with a fresh random key, derived exactly as the
-- sealed-context migration derives the first one (32 bytes from SHA-256 over four random UUIDs, stored as the HMAC
-- inner and outer padded keys). Every seal made with the old key stops verifying as soon as the rotation commits:
-- the next helper call of a transaction that entered its context before the rotation raises CONTEXT_SEAL_INVALID
-- (INTERNAL 500), and new transactions seal with the new key. A REPEATABLE READ transaction that took its snapshot
-- before the rotation keeps reading the old key until it ends.
--
-- SECURITY INVOKER on purpose: it runs with the caller's privileges, and only the owner of context_key (the
-- migration runner, which owns the definers) or a superuser can write that table, so a grant added by mistake still
-- lets nobody else rotate. No Crove role is granted EXECUTE either.

CREATE OR REPLACE FUNCTION crove_kernel.context_key_rotate()
RETURNS timestamptz LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key bytea;
  v_ipad bytea;
  v_opad bytea;
  v_at timestamptz;
  i int;
BEGIN
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
  INSERT INTO crove_kernel.context_key AS k (id, k_ipad, k_opad, created_at)
  VALUES (1, v_ipad, v_opad, pg_catalog.clock_timestamp())
  ON CONFLICT (id) DO UPDATE SET k_ipad = EXCLUDED.k_ipad, k_opad = EXCLUDED.k_opad, created_at = EXCLUDED.created_at
  RETURNING k.created_at INTO v_at;
  RETURN v_at;
END $$;

-- No Crove role may run it or touch the key (the key's grants restated from the sealed-context migration).
DO $$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON FUNCTION crove_kernel.context_key_rotate() FROM PUBLIC;
  REVOKE ALL ON crove_kernel.context_key FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.context_key_rotate() FROM %I', r.rolname);
    EXECUTE pg_catalog.format('REVOKE ALL ON crove_kernel.context_key FROM %I', r.rolname);
  END LOOP;
END $$;
ALTER TABLE crove_kernel.context_key ENABLE ROW LEVEL SECURITY;
