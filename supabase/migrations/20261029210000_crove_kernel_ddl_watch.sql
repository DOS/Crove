-- DDL outside the migration pipeline (issue #1202, plan §7.8 "Detective controls"). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.ddl_event          one row per object a DDL statement created, altered or dropped outside the pipeline:
--                                 when, the session and SET ROLE role, the command tag, the object's type, schema and
--                                 identity, the backend and client address. Never the statement text, which may hold a
--                                 secret. Global machinery table without org_id: RLS on, no policy, no grants. Kept:
--                                 only roles that may run DDL add rows, so it grows with their statements, not with
--                                 requests.
-- crove_kernel.ddl_watch()        the event trigger function, a pinned definer, so every session's DDL is recorded
--                                 whatever its role may write. The event triggers themselves (crove_ddl_watch on
--                                 ddl_command_end, crove_ddl_watch_drop on sql_drop, since a DROP reports its objects
--                                 only there) need a superuser, or the supautils privileged role on
--                                 hosted Supabase, so `migrate` creates it after the files (installDdlWatch in
--                                 packages/db/src/migrate.ts), never a migration, which runs as a non-superuser (T17).
-- crove_kernel.security_signals   gains the signal out_of_pipeline_ddl: the records not alerted yet, one alert per
--                                 session for the first 10 sessions of a pass and one out_of_pipeline_ddl_more for the
--                                 rest, marked alerted by the worker pass that reports them.
--
-- Not recorded:
--   - the pipeline's own sessions: the migration runner and auth-grants insert their backend (pid and start time) into
--     crove_meta.pipeline_session, which only the runner's role (the owner of crove_meta) and superusers may write, and
--     remove it when done. A login role cannot add its session there, and a crashed run's row matches no later
--     session, whose start time differs even when its pid is reused.
--   - Supabase Auth's own migrations, and only their objects in the `auth` schema: rows of DDL by the role that owns
--     that schema (supabase_auth_admin), when it is not a superuser and has not switched role, whose object is in
--     `auth`. That role owns the auth tables and may write their rows directly, so DDL there gives it nothing more. Its
--     DDL anywhere else (a new schema, a table outside `auth`, default privileges, a GRANT, which names no schema) is
--     recorded: the role holds CREATE on the database and its password sits in the internet-facing Supabase Auth
--     container.
--   - what PostgreSQL itself does not pass to event triggers: shared objects (roles, databases, tablespaces) and event
--     triggers. A superuser can also turn event triggers off (event_triggers = off, dropping the trigger), and so can
--     the migration role, which owns crove_meta and these objects: it can mark its own session, empty ddl_event or
--     replace ddl_watch(). This is a detective control against mistakes and stolen credentials of the other roles, not
--     against a hostile superuser or migration role.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.ddl_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  session_role text NOT NULL,
  -- The SET ROLE role, NULL when the session did not switch.
  set_role text,
  command_tag text NOT NULL,
  object_type text,
  schema_name text,
  object_identity text,
  backend_pid integer NOT NULL,
  backend_start timestamptz,
  client_addr inet,
  -- Set by the worker pass that alerted it (security_signals).
  alerted_at timestamptz
);
CREATE INDEX IF NOT EXISTS ddl_event_unalerted_idx ON crove_kernel.ddl_event (id) WHERE alerted_at IS NULL;
REVOKE ALL ON crove_kernel.ddl_event FROM PUBLIC, crove_tenant, crove_app, crove_worker;
ALTER TABLE crove_kernel.ddl_event ENABLE ROW LEVEL SECURITY;
-- An agent context never writes it (T18): the guard every crove_* table carries.
SELECT crove_kernel.agent_write_guard_install('crove_kernel.ddl_event');

-- Raises nothing of its own: a failure here fails the DDL statement, so nothing escapes unrecorded.
CREATE OR REPLACE FUNCTION crove_kernel.ddl_watch() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start timestamptz;
  v_role text := NULLIF(pg_catalog.current_setting('role'), 'none');
  v_auth_admin boolean;
BEGIN
  SELECT a.backend_start INTO v_start FROM pg_catalog.pg_stat_activity a WHERE a.pid = pg_catalog.pg_backend_pid();
  IF EXISTS (
    SELECT 1 FROM crove_meta.pipeline_session m
    WHERE m.pid = pg_catalog.pg_backend_pid() AND m.backend_start = v_start
  ) THEN
    RETURN;
  END IF;
  -- Supabase Auth's role: its objects in `auth` only (see the header).
  v_auth_admin := v_role IS NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'auth' AND r.rolname = SESSION_USER AND NOT r.rolsuper
  );

  IF TG_EVENT = 'sql_drop' THEN
    INSERT INTO crove_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, TG_TAG, d.object_type, d.schema_name, pg_catalog.left(d.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_dropped_objects() d
    WHERE d.original AND NOT d.is_temporary AND NOT (v_auth_admin AND d.schema_name IS NOT DISTINCT FROM 'auth');
  ELSE
    INSERT INTO crove_kernel.ddl_event (session_role, set_role, command_tag, object_type, schema_name, object_identity,
                                        backend_pid, backend_start, client_addr)
    SELECT SESSION_USER, v_role, c.command_tag, c.object_type, c.schema_name, pg_catalog.left(c.object_identity, 500),
           pg_catalog.pg_backend_pid(), v_start, pg_catalog.inet_client_addr()
    FROM pg_catalog.pg_event_trigger_ddl_commands() c
    WHERE c.schema_name IS DISTINCT FROM 'pg_temp' AND NOT c.in_extension
      AND NOT (v_auth_admin AND c.schema_name IS NOT DISTINCT FROM 'auth');
  END IF;
END $$;
-- An event trigger function cannot be called directly; no role needs EXECUTE to have it fire.
REVOKE ALL ON FUNCTION crove_kernel.ddl_watch() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- security_signals as in 20261027020000, plus out_of_pipeline_ddl after the loop.
CREATE OR REPLACE FUNCTION crove_kernel.security_signals(
  p_window_seconds int, p_org_threshold int, p_refusal_threshold int, p_repeat_seconds int)
RETURNS TABLE (signal text, subject text, value bigint, org_id uuid, detail text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_since timestamptz := pg_catalog.now() - pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_window_seconds, 300), 60), 86400));
  v_repeat interval := pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_repeat_seconds, 3600), 300), 604800));
  v_orgs int := LEAST(GREATEST(COALESCE(p_org_threshold, 20), 1), 1000000);
  v_refusals int := LEAST(GREATEST(COALESCE(p_refusal_threshold, 500), 1), 1000000);
  v_row record;
  c_ddl_sessions constant int := 10;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'SECURITY_SIGNALS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- Old memory goes: a signal not seen for a week alerts again as new.
  DELETE FROM crove_kernel.security_signal_seen s WHERE s.alerted_at < pg_catalog.now() - interval '7 days';

  FOR v_row IN
    SELECT 'actor_many_orgs'::text AS sig, a.actor_id::text AS subj, pg_catalog.count(DISTINCT a.org_id) AS val, NULL::uuid AS org,
           'orgs touched in the window'::text AS what
    FROM crove_kernel.audit_event a
    WHERE a.occurred_at >= v_since AND a.actor_type = 'user' AND a.actor_id IS NOT NULL
    GROUP BY a.actor_id
    HAVING pg_catalog.count(DISTINCT a.org_id) > v_orgs
    UNION ALL
    SELECT 'refusal_spike', 'deployment', t.total, NULL, 'refusals in the window'
    FROM (
      SELECT coalesce(pg_catalog.sum(r.refusals), 0)::bigint AS total
      FROM crove_kernel.refusal_tally r WHERE r.last_at >= v_since
    ) t
    WHERE t.total > v_refusals
    UNION ALL
    SELECT 'privileged_grant', a.id::text, 1, a.org_id, a.detail ->> 'role'
    FROM crove_kernel.audit_event a
    WHERE a.occurred_at >= v_since AND a.outcome = 'ok'
      AND a.command IN ('kernel.member.change_role', 'kernel.member.invite.accept')
      AND a.detail ->> 'role' IN ('owner', 'admin')
      AND (a.detail ->> 'previous_role') IS DISTINCT FROM (a.detail ->> 'role')
  LOOP
    -- Alert when the signal is new or its last alert is older than the repeat interval; a grant alerts once.
    INSERT INTO crove_kernel.security_signal_seen AS s (signal, subject, alerted_at)
    VALUES (v_row.sig, v_row.subj, pg_catalog.now())
    ON CONFLICT ON CONSTRAINT security_signal_seen_pkey DO UPDATE SET alerted_at = excluded.alerted_at
      WHERE s.alerted_at < pg_catalog.now() - v_repeat AND s.signal <> 'privileged_grant';
    IF FOUND THEN
      signal := v_row.sig;
      subject := v_row.subj;
      value := v_row.val;
      org_id := v_row.org;
      detail := v_row.what;
      RETURN NEXT;
    END IF;
  END LOOP;

  -- DDL outside the pipeline: every record not alerted yet, whatever its age, one alert per session. The UPDATE claims
  -- the rows, so with several workers each record is reported once. subject is the session's first new record,
  -- value how many there are; detail names the role and the first statement's tag and object. At most
  -- c_ddl_sessions sessions alert one by one per pass; the rest fold into one out_of_pipeline_ddl_more row (subject
  -- the first record of the first folded session, value the number of folded sessions, detail their record count),
  -- so a script that opens a session per statement posts a bounded number of messages.
  RETURN QUERY
  WITH claimed AS (
    UPDATE crove_kernel.ddl_event d SET alerted_at = pg_catalog.now()
    WHERE d.alerted_at IS NULL
    RETURNING d.id, d.session_role, d.set_role, d.command_tag, d.object_identity, d.backend_pid, d.backend_start
  ),
  sessions AS (
    SELECT c.backend_pid, c.backend_start, pg_catalog.min(c.id) AS first_id, pg_catalog.count(*) AS n,
           pg_catalog.row_number() OVER (ORDER BY pg_catalog.min(c.id)) AS rank
    FROM claimed c GROUP BY c.backend_pid, c.backend_start
  )
  SELECT x.sig, x.subj, x.val, NULL::uuid, x.what FROM (
    SELECT 'out_of_pipeline_ddl'::text AS sig, s.first_id AS ord, s.first_id::text AS subj, s.n AS val,
           pg_catalog.left(pg_catalog.format('%s%s: %s %s', f.session_role, COALESCE(' as ' || f.set_role, ''), f.command_tag,
                                             COALESCE(f.object_identity, '')), 300) AS what
    FROM sessions s JOIN claimed f ON f.id = s.first_id
    WHERE s.rank <= c_ddl_sessions
    UNION ALL
    SELECT 'out_of_pipeline_ddl_more', pg_catalog.min(s.first_id), pg_catalog.min(s.first_id)::text, pg_catalog.count(*),
           pg_catalog.format('%s schema change(s)', pg_catalog.sum(s.n))
    FROM sessions s
    WHERE s.rank > c_ddl_sessions
    HAVING pg_catalog.count(*) > 0
  ) x
  ORDER BY x.ord;
END $$;

-- EXECUTE matrix: only the worker login role (unchanged).
REVOKE ALL ON FUNCTION crove_kernel.security_signals(int, int, int, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.security_signals(int, int, int, int) TO crove_worker;
