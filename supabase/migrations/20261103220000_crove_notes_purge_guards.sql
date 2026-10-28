-- Crove Notes: guards in the reminder and purge definers (issues #1752 and #1733, ADR-0037 §2 and §4). Idempotent;
-- applied files stay untouched.
--
-- Each function below is redefined from its newest body (20261103210000_crove_notes_reminders.sql and
-- 20261103190000_crove_notes_todo.sql) with the same signature, callers and checks, plus:
--   todo_reminders_claim   the UPDATE re-checks reminded_at IS NULL, so a reminder another claim marked sent while this
--                          one waited is not marked and returned again, even without SKIP LOCKED;
--   todo_reminder_owner    answers NULL once the owner is no longer a member of the org;
--   trash_empty            removes nothing put in the trash less than 30 days ago (NOTE_TRASH_DAYS), whatever cutoff
--                          the caller passes;
--   member_items_purge     removes nothing within 30 days (NOTE_MEMBER_PURGE_DAYS) of the user's latest removal from
--                          the org that the audit trail records (kernel.member.remove, outcome ok), whenever the job
--                          runs. audit_event is append-only and never purged, so no caller can shorten the delay.
--                          kernel.member.remove is the only command that ends a membership (org_purge removes the
--                          notes with the members); a membership ended without that audit row (an SQL delete by
--                          staff) gets no delay, so a new way to remove a member must record the same row.
-- The delays no longer come from the caller alone (the job's startAfter, the command's cutoff).
--
-- New: crove_notes.former_members_due, for the worker's daily sweep: the users who own private notes or to-dos in an
-- org they are no longer a member of, past that delay. It catches a removal that queued no purge job (the notes
-- module off when the member left, a job pg-boss dropped).
SET LOCAL lock_timeout = '2s';

-- Marks up to p_limit due reminders sent and returns them, oldest first: open to-dos outside the trash whose
-- remind_at has passed and was not sent. A done, cancelled, handed-over or deleted to-do is never returned. Rows
-- another claim holds are skipped, and the UPDATE marks only a reminder still not sent, so two workers never return
-- the same one. Worker login only, outside every context.
CREATE OR REPLACE FUNCTION crove_notes.todo_reminders_claim(p_limit integer)
RETURNS TABLE (org_id uuid, id uuid, owner_user_id uuid, remind_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT t.org_id, t.id FROM crove_notes.todo t
    WHERE t.remind_at IS NOT NULL AND t.reminded_at IS NULL AND t.status = 'open' AND t.deleted_at IS NULL
      AND t.remind_at <= pg_catalog.now()
    ORDER BY t.remind_at, t.id
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE crove_notes.todo t SET reminded_at = pg_catalog.now()
  FROM due
  WHERE t.org_id = due.org_id AND t.id = due.id AND t.reminded_at IS NULL
  RETURNING t.org_id, t.id, t.owner_user_id, t.remind_at;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_reminders_claim(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_reminders_claim(integer) TO crove_worker;

-- The owner of the context's org's to-do p_todo while it is open, outside the trash, its reminder is the one for
-- p_remind_at that the claim marked sent, and the owner is still a member of the org; else NULL. Locks the row until
-- the notification is written, so the to-do is not completed, deleted or given another time in between. Worker login
-- only, in the org's system context (notes.todo.remind); returns no text.
CREATE OR REPLACE FUNCTION crove_notes.todo_reminder_owner(p_todo uuid, p_remind_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_owner uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT t.owner_user_id INTO v_owner FROM crove_notes.todo t
  WHERE t.org_id = v_org AND t.id = p_todo AND t.status = 'open' AND t.deleted_at IS NULL
    -- The worker passes the time back in milliseconds.
    AND pg_catalog.date_trunc('milliseconds', t.remind_at) = pg_catalog.date_trunc('milliseconds', p_remind_at) AND t.reminded_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = t.owner_user_id)
  FOR SHARE;
  RETURN v_owner;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_reminder_owner(uuid, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_reminder_owner(uuid, timestamptz) TO crove_worker;

-- Removes the context's org's notes and to-dos in the trash since before p_before, and never one put there less than
-- 30 days ago (NOTE_TRASH_DAYS), private ones included (worker login, in the org's system context:
-- notes.trash.empty). Returns how many.
CREATE OR REPLACE FUNCTION crove_notes.trash_empty(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  -- A NULL cutoff removes nothing, as before (LEAST alone would ignore it).
  v_before timestamptz := LEAST(COALESCE(p_before, '-infinity'::timestamptz), pg_catalog.now() - interval '30 days');
  v_n bigint;
  v_t bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.deleted_at IS NOT NULL AND n.deleted_at < v_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.deleted_at IS NOT NULL AND t.deleted_at < v_before;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  RETURN v_n + v_t;
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_empty(timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_empty(timestamptz) TO crove_worker;

-- Removes a former member's private notes and every to-do of theirs from the context's org, unless they are a member
-- again or were removed from it less than 30 days ago (NOTE_MEMBER_PURGE_DAYS; their latest kernel.member.remove in
-- the audit trail) (worker login, in the org's system context: notes.member_items.purge, 30 days after the removal or
-- from the daily sweep). Their shared notes stay with the org, and so do the tasks their handed-over to-dos became.
-- Returns how many it removed.
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
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_org AND a.occurred_at > pg_catalog.now() - interval '30 days'
      AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = p_user
  ) THEN
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

-- The users who own private notes or to-dos in an org they are no longer a member of and were not removed from in the
-- last 30 days, for the daily sweep (worker login only, outside every context): what member_items_purge would remove.
-- Ids only.
CREATE OR REPLACE FUNCTION crove_notes.former_members_due(p_limit integer)
RETURNS TABLE (org_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT d.org_id, d.user_id FROM (
      SELECT n.org_id, n.author_user_id AS user_id FROM crove_notes.note n WHERE n.visibility = 'private'
      UNION
      SELECT t.org_id, t.owner_user_id FROM crove_notes.todo t) AS d
    WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.user_id)
      AND NOT EXISTS (
        SELECT 1 FROM crove_kernel.audit_event a
        WHERE a.org_id = d.org_id AND a.occurred_at > pg_catalog.now() - interval '30 days'
          AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id)
    ORDER BY 1, 2 LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_notes.former_members_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.former_members_due(integer) TO crove_worker;
