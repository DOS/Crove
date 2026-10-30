-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove notes (issue #2036, from the review of #1992): deleting notes no longer sends one stream hint per to-do made
-- from them. Idempotent; applied files stay untouched.
--
-- A to-do keeps the note it came from in source_note_id, and todo_source_note_fk sets it to NULL when that note is
-- deleted (ON DELETE SET NULL, 20261103190000). Each such cascaded UPDATE fired the to-do's row trigger stream_hint, so
-- the trash sweep (trash_empty), a former member's purge (member_items_purge) and the org purge sent one NOTIFY per
-- to-do linked to a deleted note, however bounded the note's own delete hint is (#1992, 20261107180000).
--
-- 1. The to-do's UPDATE hint skips exactly that cascade: an update that sets source_note_id from a note to NULL inside
--    a trigger and leaves the revision as it was. An AFTER trigger's WHEN is evaluated as the row changes, so for the
--    foreign key's action, which its own trigger runs, pg_trigger_depth() is 1; a statement or a definer's update
--    outside any trigger sees 0. Every command that changes a to-do raises its revision, and the foreign key's action
--    changes source_note_id alone. The skipped hint had nothing to say: no to-do query returns source_note_id
--    (modules/notes/src/todos.ts reads it only for the export), so no screen of the to-do's owner changes. When a to-do
--    query returns the note it came from (plan N7), revisit this: the deleted note's own hint reaches the to-do's owner
--    only while they are in the note's audience. Every other update, a direct one that clears source_note_id included,
--    sends its hint as before. Skipping a hint never widens an audience.
--    The row trigger stream_hint keeps INSERT (its name and arguments, which the scans of stream_hint triggers read),
--    and the UPDATE hint moves to stream_hint_update, since a trigger's WHEN can read OLD only on UPDATE.
-- 2. member_items_purge deletes the former member's to-dos before their private notes, so the note delete finds no
--    to-do of theirs left to update. Otherwise it is the body of 20261104050000 (the newest), with its signature,
--    checks, lock, grants and the count it returns.
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS stream_hint ON crove_notes.todo;
CREATE TRIGGER stream_hint AFTER INSERT ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('todo', 'id');
DROP TRIGGER IF EXISTS stream_hint_update ON crove_notes.todo;
CREATE TRIGGER stream_hint_update AFTER UPDATE ON crove_notes.todo
  FOR EACH ROW
  WHEN (NOT (pg_catalog.pg_trigger_depth() > 0 AND OLD.source_note_id IS NOT NULL AND NEW.source_note_id IS NULL AND OLD.revision = NEW.revision))
  EXECUTE FUNCTION crove_kernel.stream_notify('todo', 'id');

-- Removes a former member's private notes and every to-do of theirs from the context's org, unless they are a member
-- again or were removed from it less than 30 days ago (NOTE_MEMBER_PURGE_DAYS; their latest kernel.member.remove in
-- the audit trail) (worker login, in the org's system context: notes.member_items.purge, 30 days after the removal or
-- from the daily sweep). Their shared notes stay with the org, and so do the tasks their handed-over to-dos became.
-- Holds the membership lock until the transaction ends, so a re-add waits or is seen. Returns how many it removed.
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
  -- A re-add of this user to the org (crove_kernel.invite_accept) either committed before this, and the check below
  -- sees it, or waits until this transaction ends.
  PERFORM crove_kernel.membership_lock(v_org, p_user);
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
  -- The to-dos first (#2036): the notes' delete then has none of theirs to unlink.
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.owner_user_id = p_user;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.author_user_id = p_user AND n.visibility = 'private';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n + v_t;
END $$;
REVOKE ALL ON FUNCTION crove_notes.member_items_purge(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.member_items_purge(uuid) TO crove_worker;
