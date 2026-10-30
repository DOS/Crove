-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #1973, from the review of #1971): the stream hint function also serves a delete trigger.
-- Idempotent; applied files stay untouched.
--
-- crove_notes.note and crove_notes.todo sent their invalidation hint on INSERT and UPDATE only. A row the trash sweep
-- (trash_empty), the purge of a former member's items (member_items_purge) or the personal-data erasure deletes sent
-- nothing, so an author with Notes open kept seeing it until a refetch, and a save then failed as not found. Their
-- stream_hint trigger now fires on DELETE too (20261107040000_crove_notes_stream_delete.sql) and sends the same hint as
-- a change, with the same routing (ADR-0037, 20261104000000_crove_kernel_stream_notes_audience.sql): a to-do and a
-- private note reach their owner's streams alone, a shared note also the streams that read shared notes; ids only.
--
-- crove_kernel.stream_notify reads the row through one variable: NEW, or OLD on a delete. Otherwise it is the function
-- of 20261104000000 (the newest) with every branch it had, its signature, owner and grants (EXECUTE for nobody). No
-- other table sends a hint on delete.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.stream_notify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
  v_entity uuid;
  v_payload text;
  v_row record;
BEGIN
  -- The row the hint is about: the new one, or on a delete (#1973) the one that is gone.
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF TG_ARGV[1] = 'file_id' THEN
    v_id := v_row.file_id;
  ELSIF TG_ARGV[1] = 'document_id' THEN
    v_id := v_row.document_id;
  ELSE
    v_id := v_row.id;
  END IF;
  IF v_row.org_id IS NULL OR v_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_payload := v_row.org_id::text || ' ' || TG_ARGV[0] || ' ' || v_id::text;
  IF TG_NARGS > 2 THEN
    IF TG_NARGS > 3 OR TG_ARGV[2] <> 'legal_entity_id' THEN
      RAISE EXCEPTION 'STREAM_HINT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_entity := v_row.legal_entity_id;
    -- Fail closed: a scoped row never becomes an org-wide hint.
    IF v_entity IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' ' || v_entity::text;
  END IF;
  -- A member's own rows: only the recipient's streams get them (a shared note also the streams that read shared
  -- notes). Fail closed, as for the entity.
  IF TG_ARGV[0] = 'notification' THEN
    IF v_row.user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || v_row.user_id::text;
  ELSIF TG_ARGV[0] = 'todo' THEN
    IF v_row.owner_user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || v_row.owner_user_id::text;
  ELSIF TG_ARGV[0] = 'note' THEN
    IF v_row.author_user_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || ' @' || v_row.author_user_id::text;
    -- OLD is read on an update only (nested, not ANDed: SQL does not promise the order an expression is evaluated in).
    IF v_row.visibility = 'org' THEN
      v_payload := v_payload || '+shared';
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD.visibility = 'org' THEN
        v_payload := v_payload || '+shared';
      END IF;
    END IF;
  END IF;
  PERFORM pg_catalog.pg_notify('crove_stream', v_payload);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.stream_notify() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant, crove_prober;

