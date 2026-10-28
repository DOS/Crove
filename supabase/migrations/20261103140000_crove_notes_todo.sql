-- Crove Notes: personal to-dos (issue #1673, plan docs/plan/notes.md §3.2, §3.4, §3.6 and step N4, ADR-0037).
-- Idempotent; applied files stay untouched.
--
-- crove_notes.todo  a member's own to-do: a title, details, checklist steps, a due day with an optional time in the
--                   member's time zone, and the member's own order (sort_key, fractional keys compared byte by byte).
--                   Always private: only a context whose user is its owner reads or changes it. Its owner is the
--                   caller, checked against the sealed context's user, and never changes; there is no foreign key to
--                   tenant_member, so a member's to-dos outlive their removal (ADR-0037 §4) until the member purge. A
--                   deleted to-do sits in the trash (deleted_at) for 30 days, then crove_notes.trash_empty removes it.
--                   task_id is set by the hand-over (N5), source_note_id by "note line to to-do" (N7); neither is
--                   written yet.
--
-- Who reads what (ADR-0037 §2): nobody but the owner. Not another member, not an owner or admin of the org, not an
-- agent context, and not the system context: the worker reaches to-dos only through the definers below, which return
-- ids and counts, never text, and the org purge deletes them as the table owner.
SET LOCAL lock_timeout = '2s';

-- A checklist: at most 50 steps, each {"text": 1 to 300 characters, "done": boolean} and nothing else. Used by the
-- table's CHECK, so it never raises: a value of another shape is false.
CREATE OR REPLACE FUNCTION crove_notes.checklist_valid(p_steps jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_step jsonb;
BEGIN
  IF p_steps IS NULL OR pg_catalog.jsonb_typeof(p_steps) <> 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_steps) > 50 THEN
    RETURN false;
  END IF;
  FOR v_step IN SELECT e FROM pg_catalog.jsonb_array_elements(p_steps) AS e LOOP
    IF pg_catalog.jsonb_typeof(v_step) <> 'object' THEN
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(v_step) AS k WHERE k NOT IN ('text', 'done')) THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_step -> 'text') IS DISTINCT FROM 'string' OR pg_catalog.jsonb_typeof(v_step -> 'done') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    IF pg_catalog.length(v_step ->> 'text') NOT BETWEEN 1 AND 300 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION crove_notes.checklist_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_notes.checklist_valid(jsonb) TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_notes.todo (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  owner_user_id uuid NOT NULL,
  -- A task title's limit, so a hand-over (N5) never truncates it; the details likewise a task description's.
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 300),
  details text CHECK (pg_catalog.length(details) <= 10000),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT todo_checklist_shape CHECK (crove_notes.checklist_valid(checklist)),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'handed_over', 'cancelled')),
  -- The day it is due, and an exact time on that day (only with a day), in the to-do's time zone.
  due_on date,
  due_at timestamptz,
  -- IANA, from the member's browser; the commands check it names a zone.
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh' CHECK (pg_catalog.length(time_zone) BETWEEN 1 AND 64),
  -- The reminder (N6): when, and when it was sent for that time.
  remind_at timestamptz,
  reminded_at timestamptz,
  -- The member's own order: a fractional key of digits and letters, compared byte by byte.
  sort_key text COLLATE "C" NOT NULL CHECK (sort_key ~ '^[0-9A-Za-z]{1,200}$'),
  source_note_id uuid,
  task_id uuid,
  -- Text that came from AI or untrusted content (N8); nothing sets it yet.
  tainted boolean NOT NULL DEFAULT false,
  -- The title, details and checklist steps folded for search (crove_kernel.search_vector), set by the trigger below.
  search tsvector NOT NULL DEFAULT ''::tsvector,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT todo_due_at_needs_day CHECK (due_at IS NULL OR due_on IS NOT NULL),
  CONSTRAINT todo_done_at CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CONSTRAINT todo_handed_over_task CHECK (status <> 'handed_over' OR task_id IS NOT NULL),
  -- The note it came from may go to the trash and away; the to-do stays.
  CONSTRAINT todo_source_note_fk FOREIGN KEY (org_id, source_note_id) REFERENCES crove_notes.note (org_id, id) ON DELETE SET NULL (source_note_id),
  -- A handed-over to-do keeps its task (todo_handed_over_task); only the org purge removes tasks, after the to-dos.
  CONSTRAINT todo_task_fk FOREIGN KEY (org_id, task_id) REFERENCES crove_kernel.task (org_id, id)
);
-- A member's list by status and due day; the trash sweep; search; the foreign keys (G3).
CREATE INDEX IF NOT EXISTS todo_owner_idx ON crove_notes.todo (org_id, owner_user_id, status, due_on);
CREATE INDEX IF NOT EXISTS todo_deleted_idx ON crove_notes.todo (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS todo_search_idx ON crove_notes.todo USING gin (search);
CREATE INDEX IF NOT EXISTS todo_source_note_idx ON crove_notes.todo (org_id, source_note_id);
CREATE INDEX IF NOT EXISTS todo_task_idx ON crove_notes.todo (org_id, task_id);
SELECT crove_kernel.apply_tenant_rls('crove_notes.todo');
-- The owner, the org, the creation time and the source note never change; nothing deletes a to-do but the definers
-- and the purge. The search words are the trigger's, and taint (N8) is not the writer's to clear.
REVOKE UPDATE, DELETE ON crove_notes.todo FROM crove_tenant;
GRANT UPDATE (title, details, checklist, status, due_on, due_at, time_zone, remind_at, reminded_at, sort_key, task_id, revision, updated_at, done_at, deleted_at)
  ON crove_notes.todo TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.todo_search() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.search := crove_kernel.search_vector(
    NEW.title || ' ' || coalesce(NEW.details, '') || ' '
    || coalesce((SELECT pg_catalog.string_agg(s.step ->> 'text', ' ') FROM pg_catalog.jsonb_array_elements(NEW.checklist) AS s(step)), ''));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_search() FROM PUBLIC;
DROP TRIGGER IF EXISTS b_search ON crove_notes.todo;
CREATE TRIGGER b_search BEFORE INSERT OR UPDATE OF title, details, checklist ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_notes.todo_search();

-- Restrictive, so they narrow the tenant policy and never widen it: the owner alone, in every context. An agent
-- context and the system context name no user, so they match no row.
DROP POLICY IF EXISTS todo_read ON crove_notes.todo;
CREATE POLICY todo_read ON crove_notes.todo AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (owner_user_id = (SELECT crove_kernel.ctx_user_id()));
-- A to-do made from a note names one the writer can read, and a to-do handed over a task the writer can read (their
-- own policies apply to the subqueries), so the foreign keys, which see every row, tell nobody whether another
-- member's note or a task of another legal entity exists.
DROP POLICY IF EXISTS todo_insert ON crove_notes.todo;
CREATE POLICY todo_insert ON crove_notes.todo AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (source_note_id IS NULL OR EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = todo.org_id AND n.id = todo.source_note_id))
    AND (task_id IS NULL OR EXISTS (SELECT 1 FROM crove_kernel.task k WHERE k.org_id = todo.org_id AND k.id = todo.task_id)));
DROP POLICY IF EXISTS todo_update ON crove_notes.todo;
CREATE POLICY todo_update ON crove_notes.todo AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (owner_user_id = (SELECT crove_kernel.ctx_user_id()))
  WITH CHECK (
    owner_user_id = (SELECT crove_kernel.ctx_user_id())
    AND (task_id IS NULL OR EXISTS (SELECT 1 FROM crove_kernel.task k WHERE k.org_id = todo.org_id AND k.id = todo.task_id)));

-- Stream hints (#69): the id of a changed to-do reaches the org's open apps, which refetch through these policies, so
-- only its owner's app sees a change.
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.todo;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('todo', 'id');

-- ---------------------------------------------------------------------------
-- Definers (ADR-0037 §2), redefined from 20261103120000_crove_notes_core.sql to reach to-dos too. Same signatures,
-- same callers and checks; none returns a title, detail or step.
-- ---------------------------------------------------------------------------

-- The orgs with notes or to-dos in the trash since before p_before, for the daily sweep (worker login only, outside
-- every context).
CREATE OR REPLACE FUNCTION crove_notes.trash_due(p_before timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT d.org_id FROM (
      SELECT n.org_id FROM crove_notes.note n WHERE n.deleted_at IS NOT NULL AND n.deleted_at < p_before
      UNION
      SELECT t.org_id FROM crove_notes.todo t WHERE t.deleted_at IS NOT NULL AND t.deleted_at < p_before) AS d
    ORDER BY 1 LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_due(timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_due(timestamptz, integer) TO crove_worker;

-- Removes the context's org's notes and to-dos in the trash since before p_before, private ones included (worker
-- login, in the org's system context: notes.trash.empty). Returns how many.
CREATE OR REPLACE FUNCTION crove_notes.trash_empty(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
  v_t bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.deleted_at IS NOT NULL AND n.deleted_at < p_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.deleted_at IS NOT NULL AND t.deleted_at < p_before;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  RETURN v_n + v_t;
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_empty(timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_empty(timestamptz) TO crove_worker;

-- Removes a former member's private notes and every to-do of theirs from the context's org, unless they are a member
-- again (worker login, in the org's system context: notes.member_items.purge, 30 days after the removal). Their shared
-- notes stay with the org, and so do the tasks their handed-over to-dos became. Returns how many it removed.
CREATE OR REPLACE FUNCTION crove_notes.member_items_purge(p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
  v_t bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user) THEN
    RETURN 0;
  END IF;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.author_user_id = p_user AND n.visibility = 'private';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.owner_user_id = p_user;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  RETURN v_n + v_t;
END $$;
REVOKE ALL ON FUNCTION crove_notes.member_items_purge(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.member_items_purge(uuid) TO crove_worker;

-- How many to-dos each member has in the context's org, outside the trash: for an owner or admin before they remove a
-- member, and for the org export, which runs in the system context and records the count of what its row policies
-- leave out. The same callers as crove_notes.private_counts(); no other context gets an answer.
CREATE OR REPLACE FUNCTION crove_notes.todo_counts()
RETURNS TABLE (org_id uuid, owner_user_id uuid, todos bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
      RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT t.org_id, t.owner_user_id, pg_catalog.count(*)
    FROM crove_notes.todo t
    WHERE t.org_id = v_org AND t.deleted_at IS NULL
    GROUP BY t.org_id, t.owner_user_id
    ORDER BY t.owner_user_id;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_counts() TO crove_tenant;
