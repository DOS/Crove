-- Crove notes (issue #1678, notes step N9, ADR-0037 section 5): telling the authors of private notes and to-dos that
-- mention a person's email address, phone number, tax code or national ID, and then deleting those items on the
-- person's erasure request, without anyone but the author ever reading them. Idempotent; applied files stay untouched.
--
-- The finder counts these items per author (crove_notes.private_matches, 20261106210000). ADR-0037 section 5: the owner
-- tells the authors first, and the erasure deletes the matching private items after they were told. So:
--
-- crove_notes.private_notice_items(kind, value)  the ids of the private notes and to-dos that mention the value, with
--                                                their authors, for the owner's notice (kernel.personal_data.notify),
--                                                which records them in its audit row and tells each author how many
--                                                of theirs it names. Ids only, never text.
-- crove_notes.private_erase(kind, value)         deletes the private notes and to-dos that mention the value and that
--                                                an earlier notice named, and answers per author how many it deleted
--                                                and how many still mention the value but were never named (made or
--                                                changed after the notice, or never told): those stay until a new
--                                                notice names them.
--
-- "Named by an earlier notice" is read from crove_kernel.audit_event (append-only): an ok row of the command
-- kernel.personal_data.notify of the context's org, written before this transaction, whose detail lists the item's id
-- under notes or todos. Only the runtime writes audit rows, from the command's own facts; a row forged with raw SQL on
-- the API connection is the residual the proposal checks accept too (#1840). An item is deleted only when it still
-- mentions the value now, so a notice cannot delete an item that no longer does.
--
-- Both are callable in a user context only, checked inside to be an owner of the context's org: the notice and the
-- erasure are owner commands (#923). No admin, member, viewer, agent or system context gets an answer or deletes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_notes.private_notice_items(p_kind text, p_value text)
RETURNS TABLE (item_type text, item_id uuid, author_user_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A value of another shape raises here, before any row is read.
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
    SELECT 'note'::text, n.id, n.author_user_id
      FROM crove_notes.note n
     WHERE n.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
            OR crove_kernel.text_mentions(n.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
    UNION ALL
    SELECT 'todo'::text, t.id, t.owner_user_id
      FROM crove_notes.todo t
     WHERE t.org_id = v_org
       AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
            OR crove_kernel.text_mentions(t.details, p_kind, p_value)
            OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value))
    ORDER BY 1, 2;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_notice_items(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_notice_items(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.private_erase(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint, untold_notes bigint, untold_todos bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
    WITH told AS (
      -- The notices of this org written before this transaction (a notice and an erasure never share one).
      SELECT a.detail FROM crove_kernel.audit_event a
       WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
         AND a.occurred_at < pg_catalog.transaction_timestamp()
         AND pg_catalog.jsonb_typeof(a.detail) = 'object'
    ),
    note_found AS (
      SELECT n.id, n.author_user_id AS author,
             EXISTS (SELECT 1 FROM told WHERE pg_catalog.jsonb_typeof(told.detail -> 'notes') = 'array' AND (told.detail -> 'notes') ? n.id::text) AS named
        FROM crove_notes.note n
       WHERE n.org_id = v_org AND n.visibility = 'private'
         AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
              OR crove_kernel.text_mentions(n.body, p_kind, p_value)
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
    ),
    todo_found AS (
      SELECT t.id, t.owner_user_id AS author,
             EXISTS (SELECT 1 FROM told WHERE pg_catalog.jsonb_typeof(told.detail -> 'todos') = 'array' AND (told.detail -> 'todos') ? t.id::text) AS named
        FROM crove_notes.todo t
       WHERE t.org_id = v_org
         AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
              OR crove_kernel.text_mentions(t.details, p_kind, p_value)
              OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value))
    ),
    note_gone AS (
      DELETE FROM crove_notes.note n USING note_found f
       WHERE n.org_id = v_org AND n.id = f.id AND f.named
      RETURNING f.author
    ),
    todo_gone AS (
      DELETE FROM crove_notes.todo t USING todo_found f
       WHERE t.org_id = v_org AND t.id = f.id AND f.named
      RETURNING f.author
    ),
    counted AS (
      SELECT g.author, 1 AS note, 0 AS todo, 0 AS untold_note, 0 AS untold_todo FROM note_gone g
      UNION ALL SELECT g.author, 0, 1, 0, 0 FROM todo_gone g
      UNION ALL SELECT f.author, 0, 0, 1, 0 FROM note_found f WHERE NOT f.named
      UNION ALL SELECT f.author, 0, 0, 0, 1 FROM todo_found f WHERE NOT f.named
    )
    SELECT c.author, pg_catalog.sum(c.note)::bigint, pg_catalog.sum(c.todo)::bigint,
           pg_catalog.sum(c.untold_note)::bigint, pg_catalog.sum(c.untold_todo)::bigint
      FROM counted c
     GROUP BY c.author
     ORDER BY c.author;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_erase(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_erase(text, text) TO crove_tenant;
