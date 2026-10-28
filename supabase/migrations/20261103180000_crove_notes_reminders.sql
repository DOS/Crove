-- Crove Notes: to-do reminders (issue #1675, plan docs/plan/notes.md §3.8 and step N6, ADR-0037). Idempotent; applied
-- files stay untouched.
--
-- A to-do's reminder is remind_at (set by notes.todo.create and notes.todo.update); reminded_at says it was sent for
-- that time. Every 5 minutes the worker claims the due ones through crove_notes.todo_reminders_claim, which marks them
-- sent and returns ids, owners and times, never a title, detail or step; for each, notes.todo.remind writes one kernel
-- notification (kind notes.todo_due, no text) for the owner. Marking before notifying means a crash in between skips a
-- reminder at worst and never sends one twice.
--
-- The system context reads no to-do (ADR-0037 §2), so the claim is a definer for the worker login alone, outside every
-- context like crove_notes.trash_due: an org's or an agent's context on the worker login gets nothing.
SET LOCAL lock_timeout = '2s';

-- The claim's scan: open to-dos outside the trash with a reminder not sent yet, by time.
CREATE INDEX IF NOT EXISTS todo_remind_idx ON crove_notes.todo (remind_at)
  WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND status = 'open' AND deleted_at IS NULL;

-- A new reminder time is a reminder not sent yet, whoever writes it: a moved due day reminds again at its new time.
CREATE OR REPLACE FUNCTION crove_notes.todo_remind_reset() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.remind_at IS DISTINCT FROM OLD.remind_at THEN
    NEW.reminded_at := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_remind_reset() FROM PUBLIC;
DROP TRIGGER IF EXISTS b_remind_reset ON crove_notes.todo;
CREATE TRIGGER b_remind_reset BEFORE UPDATE OF remind_at ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_notes.todo_remind_reset();

-- Marks up to p_limit due reminders sent and returns them, oldest first: open to-dos outside the trash whose
-- remind_at has passed and was not sent. A done, cancelled, handed-over or deleted to-do is never returned. Rows
-- another claim holds are skipped, so two workers never return the same one. Worker login only, outside every context.
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
    ORDER BY t.remind_at
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE crove_notes.todo t SET reminded_at = pg_catalog.now()
  FROM due
  WHERE t.org_id = due.org_id AND t.id = due.id
  RETURNING t.org_id, t.id, t.owner_user_id, t.remind_at;
END $$;
REVOKE ALL ON FUNCTION crove_notes.todo_reminders_claim(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_reminders_claim(integer) TO crove_worker;

-- The worker's 5-minute reminder sweep (apps/kernel/src/notes-worker.ts).
SELECT crove_jobs.create_queue('notes-reminders', '{"policy":"standard"}'::jsonb);
