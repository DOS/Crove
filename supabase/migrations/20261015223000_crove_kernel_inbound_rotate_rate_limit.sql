-- Per-org rate limit on inbound address rotation (issue #113, plan §7.6). Idempotent; applied files stay untouched.
--
-- Ledger rows in crove_kernel.inbound_address are permanent (tombstones) and every rotation adds one, so without a
-- limit an owner, or a stolen owner session, could grow the table without bound. inbound_rotate() now refuses a
-- rotation when the org already rotated, counting retired ledger rows:
--   - inbound_rotate_per_day  the per-day limit of rotations in the last 24 hours (default 3), or
--   - inbound_rotate_total    the total limit of rotations ever (default 50),
-- with INBOUND_ROTATE_RATE_LIMITED, which the runtime maps to 429 RATE_LIMITED, before writing anything. A rotation
-- is one retired row (the token an org got at creation is not a rotation). The limits come from the
-- transaction-local settings crove.inbound_rotate_limit_per_day and crove.inbound_rotate_limit_total, which the API
-- sets from its configuration (INBOUND_ROTATE_LIMIT_PER_DAY, INBOUND_ROTATE_LIMIT_TOTAL) right before the call;
-- unset means the defaults, and a malformed value is refused (INBOUND_ROTATE_LIMIT_INVALID) rather than ignored.
-- Only crove_app may execute the definer, and its owner check still applies, so a setting chosen by the caller
-- grants it nothing it could not already do within the configured limits.
--
-- A replay of an idempotency key never reaches the definer (the runtime answers it from crove_kernel.idempotency_key
-- first), so replays never count against the limit.
--
-- The count runs in the database, under a per-org advisory lock, so it holds across any number of API instances:
-- two rotations at the limit cannot both see room for one more (READ COMMITTED: the count after the lock sees the
-- row the previous holder committed). The lock, and the tenant row lock that serialized rotations before (kept, as
-- the check that the org is active), are taken under a 3s lock_timeout, set around them and restored after (the
-- hardening check allows no function setting beyond search_path), so concurrent rotations of one org cannot park a
-- pooled connection each behind them: a wait past it, or a deadlock with a concurrent rotation (see the body), is
-- refused with INBOUND_ROTATE_RATE_LIMITED (rule inbound_rotate_busy, retryAfterSeconds 1).
--
-- The retire time is now clock_timestamp() read after the lock instead of now(): a rotation whose transaction
-- started before the previous holder's would otherwise retire that holder's row at a time before its created_at
-- (CHECK inbound_address_retired_after_created). The window is measured from the same instant.
--
-- Mail queued for the old token before a rotation is dropped when the worker processes it (the org is resolved at
-- processing time, and a retired token resolves like one that never existed). That is the intended behavior for a
-- leaked address; a supplier's legitimate mail in that window is lost without a bounce. See plan §7.6.
-- The SET LOCAL below covers only this migration's DDL.
SET LOCAL lock_timeout = '2s';

-- A runner that is not a superuser must be a member of the owner role (crove_definer_tenant) to replace the function
-- and grant on it. 20261015150000 already granted that; restated so this file does not depend on it.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    EXECUTE pg_catalog.format('GRANT crove_definer_tenant TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

-- Signature unchanged; CREATE OR REPLACE keeps the owner (crove_definer_tenant) and the EXECUTE matrix of
-- 20261015150000, both restated below so this file alone leaves them right. The context is read only through the
-- sealed ctx_* helpers (20261015170000).
CREATE OR REPLACE FUNCTION crove_kernel.inbound_rotate()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('crove.inbound_rotate_limit_total', true), '');
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
  v_now timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_token text;
  v_active boolean := false;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 3);
  v_total := COALESCE(v_total_raw::integer, 50);

  -- One lock per org, then the tenant row, both held until the transaction ends (locks taken in this block's
  -- subtransaction stay held after it commits). Both waits are bounded; a deadlock is refused the same way: a
  -- concurrent rotation with an idempotency key already holds a KEY SHARE lock on the tenant row (the foreign key of
  -- its idempotency_key row) while it waits here for the advisory lock, and the holder's FOR UPDATE waits for that
  -- KEY SHARE. The deadlock detector aborts one of the two, which then gets the same 429 busy answer.
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.inbound.rotate:' || v_org::text, 0));
    PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active' FOR UPDATE;
    v_active := FOUND;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_busy', 'retryAfterSeconds', 1)::text;
  END;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);

  IF NOT v_active THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  SELECT (pg_catalog.count(*) FILTER (WHERE a.retired_at IS NOT NULL))::integer,
         (pg_catalog.count(*) FILTER (WHERE a.retired_at > v_now - interval '24 hours'))::integer,
         pg_catalog.min(a.retired_at) FILTER (WHERE a.retired_at > v_now - interval '24 hours')
    INTO v_all, v_recent, v_oldest
  FROM crove_kernel.inbound_address a
  WHERE a.org_id = v_org;
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'inbound_rotate_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    RAISE EXCEPTION 'INBOUND_ROTATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'inbound_rotate_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - v_now)))::integer)::text;
  END IF;

  UPDATE crove_kernel.inbound_address SET retired_at = v_now WHERE org_id = v_org AND retired_at IS NULL;
  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.inbound_address (org_id, token) VALUES (v_org, crove_kernel.random_token())
    ON CONFLICT (token) DO NOTHING
    RETURNING token INTO v_token;
    EXIT WHEN v_token IS NOT NULL;
  END LOOP;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'INBOUND_TOKEN_EXHAUSTED' USING ERRCODE = '23505';
  END IF;
  UPDATE crove_kernel.tenant SET inbound_token = v_token WHERE org_id = v_org;
  RETURN v_token;
END $$;

-- Ownership and EXECUTE matrix restated, as in 20261015150000: owned by the NOLOGIN definer role (tenant RLS stays
-- in force inside it), executable by the API login role alone.
GRANT CREATE ON SCHEMA crove_kernel TO crove_definer_tenant;
ALTER FUNCTION crove_kernel.inbound_rotate() OWNER TO crove_definer_tenant;
REVOKE CREATE ON SCHEMA crove_kernel FROM crove_definer_tenant;

REVOKE ALL ON FUNCTION crove_kernel.inbound_rotate() FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.inbound_rotate() TO crove_app;
