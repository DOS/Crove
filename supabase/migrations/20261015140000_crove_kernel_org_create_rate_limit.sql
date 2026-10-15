-- Per-user rate limit on org creation (External-tenant gate T4, issue #94, plan §4.4 step 0). Idempotent.
--
-- create_or_replay_org now refuses a new org when its caller already created, counting every status:
--   - org_create_per_day  the per-day limit of orgs in the last 24 hours (default 5), or
--   - org_create_total    the total limit of orgs ever (default 20),
-- with ORG_CREATE_RATE_LIMITED, which the runtime maps to 429 RATE_LIMITED. The limits come from the
-- transaction-local settings crove.org_create_limit_per_day and crove.org_create_limit_total, which the API
-- sets from its configuration (ORG_CREATE_LIMIT_PER_DAY, ORG_CREATE_LIMIT_TOTAL) right before the call; unset
-- means the defaults, and a malformed value is refused rather than ignored. Only crove_app may execute the
-- definer, and it already chooses p_user_id, so a setting chosen by the caller grants it nothing new.
--
-- The count runs in the database, so it holds across any number of API instances. The advisory lock is now
-- per user instead of per (user, idempotency key): every creation by one user is serialized, so two requests
-- at the limit cannot both see room for one more (READ COMMITTED: the count after the lock sees the org the
-- previous holder committed). The per-key lock it replaces is implied by it. A replay of an existing key
-- returns its org before the count, so replays never count against the limit.
SET LOCAL lock_timeout = '2s';

-- The count reads orgs by creator and creation time.
CREATE INDEX IF NOT EXISTS tenant_created_by_idx ON crove_kernel.tenant (created_by, created_at);

-- Signature, owner, grants and settings unchanged (CREATE OR REPLACE keeps the EXECUTE matrix of
-- 20261015092600: crove_app alone).
CREATE OR REPLACE FUNCTION crove_kernel.create_or_replay_org(p_user_id uuid, p_slug text, p_name text, p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid;
  v_slug text := p_slug;
  v_per_day_raw text := NULLIF(pg_catalog.current_setting('crove.org_create_limit_per_day', true), '');
  v_total_raw text := NULLIF(pg_catalog.current_setting('crove.org_create_limit_total', true), '');
  v_per_day integer;
  v_total integer;
  v_recent integer;
  v_all integer;
  v_oldest timestamptz;
BEGIN
  IF (v_per_day_raw IS NOT NULL AND v_per_day_raw !~ '^[1-9][0-9]{0,5}$')
     OR (v_total_raw IS NOT NULL AND v_total_raw !~ '^[1-9][0-9]{0,5}$') THEN
    RAISE EXCEPTION 'ORG_CREATE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_per_day := COALESCE(v_per_day_raw::integer, 5);
  v_total := COALESCE(v_total_raw::integer, 20);

  -- One lock per user, taken before the replay lookup and the count, held until the transaction ends.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.create:' || p_user_id::text, 0));
  IF p_idempotency_key IS NOT NULL THEN
    SELECT k.org_id INTO v_org
    FROM crove_kernel.idempotency_key k
    WHERE k.actor_key = 'user:' || p_user_id::text AND k.key = p_idempotency_key AND k.command = 'kernel.org.create';
    IF v_org IS NOT NULL THEN
      RETURN v_org;
    END IF;
  END IF;

  SELECT pg_catalog.count(*)::integer,
         (pg_catalog.count(*) FILTER (WHERE t.created_at > pg_catalog.now() - interval '24 hours'))::integer,
         pg_catalog.min(t.created_at) FILTER (WHERE t.created_at > pg_catalog.now() - interval '24 hours')
    INTO v_all, v_recent, v_oldest
  FROM crove_kernel.tenant t
  WHERE t.created_by = p_user_id;
  IF v_all >= v_total THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object('rule', 'org_create_total', 'limit', v_total)::text;
  END IF;
  IF v_recent >= v_per_day THEN
    RAISE EXCEPTION 'ORG_CREATE_RATE_LIMITED' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.json_build_object(
        'rule', 'org_create_per_day',
        'limit', v_per_day,
        'retryAfterSeconds', GREATEST(1, pg_catalog.ceil(
          pg_catalog.date_part('epoch', v_oldest + interval '24 hours' - pg_catalog.now())))::integer)::text;
  END IF;

  FOR attempt IN 1..5 LOOP
    INSERT INTO crove_kernel.tenant (slug, name, created_by) VALUES (v_slug, p_name, p_user_id)
    ON CONFLICT (slug) DO NOTHING
    RETURNING org_id INTO v_org;
    EXIT WHEN v_org IS NOT NULL;
    v_slug := pg_catalog.left(p_slug, 40) || '-' || pg_catalog.left(crove_kernel.random_token(), 4);
  END LOOP;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ORG_SLUG_TAKEN' USING ERRCODE = '23505';
  END IF;
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  RETURN v_org;
END $$;

-- Restated so this file alone leaves the matrix right (crove_app alone).
REVOKE ALL ON FUNCTION crove_kernel.create_or_replay_org(uuid, text, text, text)
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.create_or_replay_org(uuid, text, text, text) TO crove_app;
