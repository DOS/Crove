-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1992, from the review of #1987): a bulk delete of notes or to-dos sends one stream hint per
-- audience, not one per row. Idempotent; applied files stay untouched.
--
-- Since #1973 (20261107030000, 20261107040000) the stream_hint trigger of crove_notes.note and crove_notes.todo fires
-- FOR EACH ROW on DELETE too, so a bulk delete (the org purge, the trash sweep trash_empty, a former member's
-- member_items_purge, the personal-data erasure) wrote one NOTIFY per row: about 15 MB for 100k rows at commit, while
-- holding PostgreSQL's cluster-wide NOTIFY lock, which every other transaction sending a NOTIFY waits on.
--
-- The app reads a to-do or note hint by its type alone (apps/app/src/lib/stream.ts: every notes.* or notes.todos.*
-- query reads again), so one hint per audience carries all a bulk delete has to say. A delete now fires a statement
-- trigger with the deleted rows as a transition table, and crove_kernel.stream_notify_deleted sends one hint per org
-- and audience, with the same routing as crove_kernel.stream_notify (20261104000000_crove_kernel_stream_notes_
-- audience.sql, ADR-0037): a to-do to its owner's streams (`@<owner_user_id>`), a note to its author's
-- (`@<author_user_id>`), a shared note (visibility 'org') also to the streams that read shared notes (`+shared`).
-- Private and shared notes of one author are separate audiences, so a private note never rides on a `+shared` hint.
-- The hint names one of the group's deleted ids (the lowest), ids only as before. The NOTIFYs of a statement are
-- bounded by its orgs and members, not by its rows; a delete of one row sends exactly the hint it sent before.
--
-- INSERT and UPDATE keep the row trigger (stream_hint, crove_kernel.stream_notify unchanged), so the scans of
-- stream_hint triggers (stream-legal-entity.db.test.ts) still see both tables with their org-wide arguments.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.stream_notify_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hint record;
BEGIN
  -- Only as the statement trigger below: AFTER DELETE with the deleted rows as `gone`, for a to-do or a note.
  IF TG_LEVEL <> 'STATEMENT' OR TG_OP <> 'DELETE' OR TG_NARGS <> 2 OR TG_ARGV[1] <> 'id' OR TG_ARGV[0] NOT IN ('todo', 'note') THEN
    RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A row without its org, id or recipient sends nothing (fail closed, as stream_notify).
  IF TG_ARGV[0] = 'todo' THEN
    FOR v_hint IN
      SELECT g.org_id, pg_catalog.min(g.id::text) AS id, g.owner_user_id AS user_id, false AS shared
      FROM gone g
      WHERE g.org_id IS NOT NULL AND g.id IS NOT NULL AND g.owner_user_id IS NOT NULL
      GROUP BY g.org_id, g.owner_user_id
      ORDER BY 1, 3
    LOOP
      PERFORM pg_catalog.pg_notify('crove_stream', v_hint.org_id::text || ' todo ' || v_hint.id || ' @' || v_hint.user_id::text);
    END LOOP;
  ELSE
    FOR v_hint IN
      SELECT g.org_id, pg_catalog.min(g.id::text) AS id, g.author_user_id AS user_id, g.visibility IS NOT DISTINCT FROM 'org' AS shared
      FROM gone g
      WHERE g.org_id IS NOT NULL AND g.id IS NOT NULL AND g.author_user_id IS NOT NULL
      GROUP BY g.org_id, g.author_user_id, g.visibility IS NOT DISTINCT FROM 'org'
      ORDER BY 1, 3, 4
    LOOP
      PERFORM pg_catalog.pg_notify(
        'crove_stream',
        v_hint.org_id::text || ' note ' || v_hint.id || ' @' || v_hint.user_id::text || CASE WHEN v_hint.shared THEN '+shared' ELSE '' END
      );
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_notify_deleted() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

-- The row trigger on INSERT and UPDATE only (as before 20261107040000), and the statement trigger on DELETE.
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.note;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.note
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('note', 'id');
DROP TRIGGER IF EXISTS stream_hint_delete ON crove_notes.note;
CREATE TRIGGER stream_hint_delete AFTER DELETE ON crove_notes.note
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.stream_notify_deleted('note', 'id');

DROP TRIGGER IF EXISTS stream_hint ON crove_notes.todo;
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.todo
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('todo', 'id');
DROP TRIGGER IF EXISTS stream_hint_delete ON crove_notes.todo;
CREATE TRIGGER stream_hint_delete AFTER DELETE ON crove_notes.todo
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION crove_kernel.stream_notify_deleted('todo', 'id');
