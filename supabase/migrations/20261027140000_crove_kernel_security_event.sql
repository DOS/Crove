-- Refusals before membership is established (issue #1006, plan §4.4 step 3, §4.10, gate row T4, red-team S24).
-- Idempotent; applied files stay untouched.
--
-- A command refused before the caller is a member of the org (NOT_A_MEMBER from enter_context, a closed org, an
-- org-less command such as kernel.org.create refused past its rate limit, whose new org rolls back) has no org to be
-- audited in: the audit row goes into an org only through the actor's own context. Neither has the refusal of a
-- member removed between the command and its refusal audit row. These refusals are noted here instead.
--
-- crove_kernel.security_event   one row per fixed window, caller, command, code and target org, counting the
--                               refusals (refusals, first_at, last_at). target_org is the org the caller named, which
--                               may not exist: it is not a tenant key and has no foreign key. Global machinery table
--                               without org_id: RLS on, no policy, no grants (like security_signal_seen).
--
-- Sampled, so outsiders cannot grow it without limit (S24): in each window a caller gets at most
-- SECURITY_EVENT_ROWS_PER_CALLER (20) rows naming a target. Past that, its refusals of a (command, code) fold into one
-- overflow row with no target. The rows grow with callers, windows and the fixed sets of commands and codes, never
-- with the request rate or with the org ids a caller makes up. As in refusal_tally, the count is read before the
-- upsert without a lock, so a burst can pass the bound by the refusals in flight at once; that bounds growth, it is
-- not an exact quota. Kept 30 days: crove_kernel.security_event_prune() (run by the worker) deletes older windows.
--
-- The caller is named by the runtime (user:<id> or agent:<agent id>, from a verified token or the worker's own run),
-- since a refused caller has no sealed context. crove_app (API) and crove_worker may execute the note; a login role
-- calling it outside a refusal can only add counted refusals for callers it names, which needs SQL access as that
-- role in the first place. Only crove_worker may execute the prune. Ids and codes only: no input, no message.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.security_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_start timestamptz NOT NULL,
  caller text NOT NULL CHECK (caller ~ '^(user|agent):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  command text NOT NULL CHECK (pg_catalog.length(command) BETWEEN 1 AND 200),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  -- NULL on an overflow row, and for a refusal that names no org (an org-less command).
  target_org uuid,
  overflow boolean NOT NULL DEFAULT false,
  refusals bigint NOT NULL DEFAULT 1 CHECK (refusals >= 1),
  first_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT security_event_overflow_untargeted CHECK (NOT overflow OR target_org IS NULL),
  CONSTRAINT security_event_key UNIQUE NULLS NOT DISTINCT (window_start, caller, command, code, target_org, overflow)
);
-- The prune deletes by age.
CREATE INDEX IF NOT EXISTS security_event_window_idx ON crove_kernel.security_event (window_start);
REVOKE ALL ON crove_kernel.security_event FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_kernel.security_event ENABLE ROW LEVEL SECURITY;
-- An agent context never writes it (T18): the guard every crove_* table carries. The note runs with no context.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.security_event');

-- Notes one refusal. Raises SECURITY_EVENT_INVALID (22023) for an argument out of shape (the runtime builds them, so
-- that is a bug). Runs with no tenant context and refuses inside one: a refusal after membership belongs to the org's
-- audit (refusal_tally_note), never here.
CREATE OR REPLACE FUNCTION crove_kernel.security_event_note(p_caller text, p_command text, p_code text, p_target_org uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- One-hour windows, aligned on the Unix epoch, so every API instance agrees on them.
  c_window_seconds constant integer := 3600;
  c_rows_per_caller constant integer := 20;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window timestamptz;
  v_rows bigint;
  v_seen boolean;
  v_target uuid := p_target_org;
  v_overflow boolean := false;
BEGIN
  IF crove_kernel.ctx_org_id() IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY_EVENT_IN_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_caller IS NULL OR p_caller !~ '^(user|agent):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_command IS NULL OR pg_catalog.length(p_command) NOT BETWEEN 1 AND 200
     OR p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_]{0,99}$' THEN
    RAISE EXCEPTION 'SECURITY_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_window := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', v_now) / c_window_seconds) * c_window_seconds);

  IF v_target IS NOT NULL THEN
    SELECT pg_catalog.count(*),
           COALESCE(pg_catalog.bool_or(e.command = p_command AND e.code = p_code AND e.target_org = v_target), false)
      INTO v_rows, v_seen
    FROM crove_kernel.security_event e
    WHERE e.window_start = v_window AND e.caller = p_caller AND e.target_org IS NOT NULL;
    IF NOT v_seen AND v_rows >= c_rows_per_caller THEN
      v_target := NULL;
      v_overflow := true;
    END IF;
  END IF;

  INSERT INTO crove_kernel.security_event AS e (window_start, caller, command, code, target_org, overflow, refusals, first_at, last_at)
  VALUES (v_window, p_caller, p_command, p_code, v_target, v_overflow, 1, v_now, v_now)
  ON CONFLICT ON CONSTRAINT security_event_key DO UPDATE
    SET refusals = e.refusals + 1,
        last_at = GREATEST(e.last_at, EXCLUDED.last_at);
END $$;

-- Deletes windows that started more than p_keep_days ago, at most p_batch rows per call, and returns how many it
-- deleted. Maintenance with no tenant context: only the worker login role may execute it.
CREATE OR REPLACE FUNCTION crove_kernel.security_event_prune(p_keep_days integer, p_batch integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days NOT BETWEEN 1 AND 3650 OR p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'SECURITY_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM crove_kernel.security_event e
  WHERE e.id = ANY (ARRAY(
    SELECT o.id FROM crove_kernel.security_event o
    WHERE o.window_start < pg_catalog.now() - pg_catalog.make_interval(days => p_keep_days)
    LIMIT p_batch));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.security_event_note(text, text, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.security_event_note(text, text, text, uuid) TO crove_app, crove_worker;
REVOKE ALL ON FUNCTION crove_kernel.security_event_prune(integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.security_event_prune(integer, integer) TO crove_worker;
