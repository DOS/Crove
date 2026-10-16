-- Per-actor and per-org bound on refusal audit rows (issue #162, plan §4.4 step 14 and §4.10). Idempotent; applied
-- files stay untouched.
--
-- Every refused command (403, and 404, 409 and 422 once membership is established) writes a denied/failed row to the
-- append-only crove_kernel.audit_event in its own short transaction. Without a bound, a member sending refused
-- requests in a loop grows audit_event without limit. The refusal transaction now first calls
-- crove_kernel.refusal_tally_note(), which counts the refusal in crove_kernel.refusal_tally and answers whether the
-- audit row is still written. In each window, a refusal gets its row when any of these holds:
--   - it is the first refusal of its (command, code) by this actor, so no kind of refusal goes unrecorded;
--   - the actor has fewer than p_reserve refusals, a per-actor reserve that the org bound does not touch, so one
--     member flooding the org's budget cannot suppress another member's rows;
--   - the actor has fewer than p_actor_limit refusals, and the org fewer than p_org_limit or the refusal is security
--     relevant (p_security: the runtime's explicit list of codes, such as STEP_UP_REQUIRED and FORBIDDEN, and every
--     404 after the org was entered). A security-relevant refusal is therefore bounded by the actor's own limit only.
-- The runtime passes REFUSAL_AUDIT_LIMIT_PER_ACTOR, REFUSAL_AUDIT_LIMIT_PER_ORG and REFUSAL_AUDIT_RESERVE_PER_ACTOR
-- (defaults 50, 500 and 10) over windows of REFUSAL_AUDIT_WINDOW_SECONDS (default 3600). Past the bound a refusal is
-- only counted: refusals counts every refusal of the (command, code) in the window, audited how many of them got an
-- audit row, first_at and last_at when the first and last arrived. The tally grows with windows that saw refusals and
-- the distinct (command, code) pairs per actor, never with the request rate, and crove_kernel.refusal_tally_prune()
-- (run by the worker) deletes windows older than its retention.
--
-- Windows are fixed, aligned on multiples of the window length since the Unix epoch, so every API instance agrees
-- on them; the count runs in the database and holds across instances. The limits are checked before the upsert
-- without a lock, so a burst of concurrent refusals can pass a limit by at most the refusals in flight at once
-- (bounded by the API's connection pools and the per-actor request limit at the HTTP edge). That is a bound on growth,
-- not an exact quota, and serializing every refusal of an org behind a lock would hand a flooding member a way to
-- hold the pool.
--
-- Machinery table: no role but its owner holds a privilege on it, row-level security is on with no policy (like
-- auth_session_org), and only the definers below, owned by the table owner, touch it. The org and the actor come from
-- the sealed context (ctx_* helpers), never from the caller, so a call can only count refusals of the caller's own
-- context. crove_app (API) and crove_worker (system actors) may execute the note; a login role calling it outside a
-- refusal can only make its own refusals collapse sooner, which needs SQL access as that login role in the first
-- place. Only crove_worker may execute the prune.
-- The SET LOCAL below covers only this migration's DDL.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.refusal_tally (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  -- user:<user id> for a user, system for a system actor (the sealed context names no component).
  actor_key text NOT NULL CHECK (pg_catalog.length(actor_key) BETWEEN 1 AND 100),
  command text NOT NULL CHECK (pg_catalog.length(command) BETWEEN 1 AND 200),
  code text NOT NULL CHECK (pg_catalog.length(code) BETWEEN 1 AND 100),
  refusals bigint NOT NULL DEFAULT 1 CHECK (refusals >= 1),
  audited bigint NOT NULL DEFAULT 0,
  first_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, window_start, actor_key, command, code),
  CONSTRAINT refusal_tally_audited CHECK (audited >= 0 AND audited <= refusals)
);
-- The prune deletes by age across orgs.
CREATE INDEX IF NOT EXISTS refusal_tally_window_idx ON crove_kernel.refusal_tally (window_start);
REVOKE ALL ON crove_kernel.refusal_tally FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_kernel.refusal_tally ENABLE ROW LEVEL SECURITY;

-- Counts one refusal of the current context and answers whether its audit row is written (see above). Raises
-- NO_CONTEXT (42501) without a context, and REFUSAL_TALLY_INVALID (22023) for arguments out of range (the runtime
-- validates its configuration, so either one is a bug).
CREATE OR REPLACE FUNCTION crove_kernel.refusal_tally_note(
  p_command text, p_code text, p_security boolean, p_actor_limit integer, p_org_limit integer, p_reserve integer,
  p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor_type text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_actor text;
  v_window timestamptz;
  v_actor_n bigint;
  v_org_n bigint;
  v_seen boolean;
  v_audit boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type = 'user' AND v_user IS NOT NULL THEN
    v_actor := 'user:' || v_user::text;
  ELSIF v_actor_type = 'system' THEN
    v_actor := 'system';
  ELSE
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_command IS NULL OR pg_catalog.length(p_command) NOT BETWEEN 1 AND 200
     OR p_code IS NULL OR pg_catalog.length(p_code) NOT BETWEEN 1 AND 100
     OR p_security IS NULL
     OR p_actor_limit IS NULL OR p_actor_limit NOT BETWEEN 1 AND 999999
     OR p_org_limit IS NULL OR p_org_limit NOT BETWEEN 1 AND 999999
     OR p_reserve IS NULL OR p_reserve NOT BETWEEN 0 AND p_actor_limit
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'REFUSAL_TALLY_INVALID' USING ERRCODE = '22023';
  END IF;

  v_window := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', v_now) / p_window_seconds) * p_window_seconds);

  -- Rows of one org and window: one per actor and (command, code), read through the primary key.
  SELECT COALESCE(pg_catalog.sum(t.refusals) FILTER (WHERE t.actor_key = v_actor), 0),
         COALESCE(pg_catalog.sum(t.refusals), 0),
         COALESCE(pg_catalog.bool_or(t.actor_key = v_actor AND t.command = p_command AND t.code = p_code), false)
    INTO v_actor_n, v_org_n, v_seen
  FROM crove_kernel.refusal_tally t
  WHERE t.org_id = v_org AND t.window_start = v_window;

  v_audit := NOT v_seen
    OR v_actor_n < p_reserve
    OR (v_actor_n < p_actor_limit AND (p_security OR v_org_n < p_org_limit));

  INSERT INTO crove_kernel.refusal_tally AS t (org_id, window_start, actor_key, command, code, refusals, audited, first_at, last_at)
  VALUES (v_org, v_window, v_actor, p_command, p_code, 1, CASE WHEN v_audit THEN 1 ELSE 0 END, v_now, v_now)
  ON CONFLICT (org_id, window_start, actor_key, command, code) DO UPDATE
    SET refusals = t.refusals + 1,
        audited = t.audited + EXCLUDED.audited,
        last_at = GREATEST(t.last_at, EXCLUDED.last_at);
  RETURN v_audit;
END $$;

-- Deletes windows that started more than p_keep_days ago, at most p_batch rows per call, and returns how many it
-- deleted. Maintenance across orgs, with no tenant context: only the worker login role may execute it.
CREATE OR REPLACE FUNCTION crove_kernel.refusal_tally_prune(p_keep_days integer, p_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days NOT BETWEEN 1 AND 3650 OR p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'REFUSAL_TALLY_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.refusal_tally t
  WHERE t.ctid = ANY (ARRAY(
    SELECT o.ctid FROM crove_kernel.refusal_tally o
    WHERE o.window_start < pg_catalog.now() - pg_catalog.make_interval(days => p_keep_days)
    LIMIT p_batch));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.refusal_tally_note(text, text, boolean, integer, integer, integer, integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.refusal_tally_note(text, text, boolean, integer, integer, integer, integer)
  TO crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.refusal_tally_prune(integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.refusal_tally_prune(integer, integer) TO crove_worker;
