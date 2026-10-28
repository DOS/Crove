-- The invalidation hints of to-dos and notes reach only the members who may read the row (issue #1753, found in the
-- review of #1702). Idempotent; applied files stay untouched.
--
-- crove_notes.todo is its owner's alone (todo_read), and crove_notes.note its author's alone while private; a shared
-- note ('org') is read by its author and by owners, admins and members whose scope is the whole org (note_read), not
-- by viewers or members limited to some entities. Their hints still went to every open stream of the org, so every
-- member learned the id and timing of each change to a colleague's to-dos and notes. Since #1702 a member's own row
-- names its recipient last (`@<user_id>`), and the API hands it only to that user's streams. This extends it:
--     todo   <org_id> todo <id> @<owner_user_id>
--     note   <org_id> note <id> @<author_user_id>          a private note: its author alone
--            <org_id> note <id> @<author_user_id>+shared   a shared note, or one that was shared until this change:
--                                                         its author, and the streams whose kernel.stream.check
--                                                         grants sharedNotes (note_read's rule, in
--                                                         packages/kernel/src/queries.ts)
-- An update that makes a shared note private still reaches the members who could read it until then, so their open
-- list drops it; they learn only that a note they could see changed. A row without its user sends nothing (fail
-- closed); both user columns are NOT NULL. The routing is never sent to a client: an `invalidate` is still {type, id}.
-- The payload still holds ids only (any role may LISTEN on any channel).
--
-- As for the notification (#1702), the hint type says how a hint is routed, not a trigger argument, so the triggers
-- keep their arguments. This replaces the function of 20261103220000_crove_kernel_stream_recipient.sql with every
-- branch it had (the id column of TG_ARGV[1], the entity of TG_ARGV[2] and its fail-closed check, STREAM_HINT_INVALID
-- for any other argument, the notification's recipient) and keeps its signature, owner and grants (EXECUTE for
-- nobody). No trigger changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.stream_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_entity uuid;
  v_payload text;
BEGIN
  IF TG_ARGV[1] = 'file_id' THEN
    v_id := NEW.file_id;
  ELSIF TG_ARGV[1] = 'document_id' THEN
    v_id := NEW.document_id;
  ELSE
    v_id := NEW.id;
  END IF;
  IF NEW.org_id IS NULL OR v_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_payload := NEW.org_id::text || ' ' || TG_ARGV[0] || ' ' || v_id::text;
  IF TG_NARGS > 2 THEN
    IF TG_NARGS > 3 OR TG_ARGV[2] <> 'legal_entity_id' THEN
      RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_entity := NEW.legal_entity_id;
    -- Fail closed: a scoped row never becomes an org-wide hint.
    IF v_entity IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' ' || v_entity::text;
  END IF;
  -- A member's own rows: only the recipient's streams get them (a shared note also the streams that read shared
  -- notes). Fail closed, as for the entity.
  IF TG_ARGV[0] = 'notification' THEN
    IF NEW.user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || NEW.user_id::text;
  ELSIF TG_ARGV[0] = 'todo' THEN
    IF NEW.owner_user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || NEW.owner_user_id::text;
  ELSIF TG_ARGV[0] = 'note' THEN
    IF NEW.author_user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || NEW.author_user_id::text;
    IF NEW.visibility = 'org' OR (TG_OP = 'UPDATE' AND OLD.visibility = 'org') THEN
      v_payload := v_payload || '+shared';
    END IF;
  END IF;
  PERFORM pg_catalog.pg_notify('crove_stream', v_payload);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_notify() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;
