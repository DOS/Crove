-- Crove notes (issue #1973, from the review of #1971): a hard-deleted note or to-do tells its readers' open apps.
-- Idempotent; applied files stay untouched.
--
-- The stream_hint trigger of crove_notes.note and crove_notes.todo fires on DELETE too, and sends the hint of the row
-- that is gone through crove_kernel.stream_notify, which reads OLD on a delete
-- (20261107030000_crove_kernel_stream_notify_delete.sql): a to-do and a private note reach their owner's streams alone,
-- a shared note also the streams that read shared notes; ids only. It fires for every path that deletes them: the
-- trash sweep (trash_empty), the purge of a former member's items (member_items_purge) and the personal-data erasure,
-- so no definer changes.
SET LOCAL lock_timeout = '2s';

-- The same trigger as before (20261103130000, 20261103190000), on DELETE too, so the scans of stream_hint triggers
-- (stream-legal-entity.db.test.ts) still see every hint these tables send.
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.note;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE OR DELETE ON crove_notes.note
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('note', 'id');
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.todo;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE OR DELETE ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('todo', 'id');
