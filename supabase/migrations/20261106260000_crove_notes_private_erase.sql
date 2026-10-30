-- Crove notes (issue #1678, notes step N9, ADR-0037 section 5): telling the authors of private notes and to-dos that
-- mention a person's email address, phone number, tax code or national ID, and then deleting those items on the
-- person's erasure request, without anyone but the author ever reading them. Idempotent; applied files stay untouched.
--
-- The finder counts these items per author (crove_notes.private_matches, 20261106210000). ADR-0037 section 5: the owner
-- tells the authors first, and the erasure deletes the matching private items after they were told. So:
--
-- crove_notes.private_notice_items(kind, value)  the ids and revisions of the private notes and to-dos that mention
--                                                the value, with their authors, for the owner's notice
--                                                (kernel.personal_data.notify), which records them in its audit row
--                                                and tells each author how many of theirs it names. Never text.
-- crove_notes.private_erase(kind, value)         deletes the private notes and to-dos that mention the value and that
--                                                an earlier notice named and told their author about, and answers per
--                                                author how many it deleted, with their ids, and how many still
--                                                mention the value but were not (made or changed after the notice, not
--                                                told yet, or told less than 24 hours ago): those stay until a notice
--                                                names them and 24 hours have passed.
--
-- crove_notes.private_notice_key(kind, value)    the notice's key of the value, which its audit row records, so an
--                                                erasure counts only the notices sent for the same value.
--
-- An item counts as named and told when an ok row of the command kernel.personal_data.notify in
-- crove_kernel.audit_event (append-only), of the context's org and written at least 24 hours before this transaction:
--   - was sent for this value: its detail.key is the value's notice key, an HMAC-SHA256 under the deployment's hash
--     key (crove_kernel.mail_hash_key, never rotated, shared by domain separation as command_input_hash does, #1732)
--     over a domain label, the org, the kind and the value, so a notice for one person never covers the erasure of
--     another whom the same note names, and the key reveals nothing of the value without the deployment's key;
--   - lists '<id>:<revision>' of the item, as it is now, under notes or todos: an item changed since (its revision
--     moved) was not seen by that notice;
--   - and its author was told at least 24 hours ago: a kernel.personal_data_notice notification for the author with
--     that notice's event, written that long ago (kernel.notification.dispatch writes it from the event the notice
--     emitted, detail.event), or the author is the owner who sent the notice (never notified of their own action).
--     The wait gives the author time to read the notice and download their items (#1678, the coordinator's security
--     review of #1971); the runbook asks for at least one working day, inside the legal deadline. A former member gets no notification, so their
--     items stay until the 30-day purge of ADR-0037 section 4 (no exemption here, which a re-add could race).
-- A notice whose notifications were never written (the worker down) or were pruned (30 days after being read, 90
-- unread) deletes nothing: the owner sends another. Only the runtime writes audit rows, from the command's own facts,
-- and only system commands write notifications; a row forged with raw SQL on the API connection is the residual the
-- proposal checks accept too (#1840). An item is deleted only when it still mentions the value now.
--
-- The three are callable in a user context only, checked inside to be an owner of the context's org: the notice and
-- the erasure are owner commands (#923). No admin, member, viewer, agent or system context gets an answer or deletes.
SET LOCAL lock_timeout = '2s';

-- The notice key of a value in an org (above). A helper, executable by no login role.
CREATE OR REPLACE FUNCTION crove_notes.private_notice_key_of(p_org uuid, p_kind text, p_value text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
  v_value text;
BEGIN
  -- The parts are separated by chr(31). Only the value may hold one (an email's local part may hold a control
  -- character), and it comes last, so two different (org, kind, value) never make one message: the org is a uuid and
  -- the kind 'email' or 'digits', as text_mention_pattern checked before any caller gets here.
  -- A phone given with 84 is keyed as with its leading 0, as the pattern matches both: a notice sent for
  -- '+84 912 345 678' covers an erasure of '0912 345 678'.
  v_value := CASE WHEN p_kind = 'digits' AND p_value ~ '^84[0-9]{9,10}$' THEN '0' || pg_catalog.substr(p_value, 3) ELSE p_value END;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN 'k1:' || pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'crove.notes.notice.v1' || pg_catalog.chr(31) || p_org::text || pg_catalog.chr(31) || p_kind || pg_catalog.chr(31) || v_value, 'UTF8'))),
    'hex');
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_notice_key_of(uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_notes.private_notice_key(p_kind text, p_value text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
  RETURN crove_notes.private_notice_key_of(v_org, p_kind, p_value);
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_notice_key(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_notice_key(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.private_notice_items(p_kind text, p_value text)
RETURNS TABLE (item_type text, item_id uuid, author_user_id uuid, revision integer) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
    SELECT 'note'::text, n.id, n.author_user_id, n.revision
      FROM crove_notes.note n
     WHERE n.org_id = v_org AND n.visibility = 'private'
       AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
            OR crove_kernel.text_mentions(n.body, p_kind, p_value)
            OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
    UNION ALL
    SELECT 'todo'::text, t.id, t.owner_user_id, t.revision
      FROM crove_notes.todo t
     WHERE t.org_id = v_org
       AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
            OR crove_kernel.text_mentions(t.details, p_kind, p_value)
            OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value))
    ORDER BY 1, 2;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_notice_items(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_notice_items(text, text) TO crove_tenant;

-- Whether a notice reached an author at least 24 hours ago (above): the owner who sent it, or a member with the
-- notice's notification written that long ago. A helper of private_erase, executable by no login role.
CREATE OR REPLACE FUNCTION crove_notes.private_notice_told(p_org uuid, p_author uuid, p_sender uuid, p_event text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_author = p_sender
      OR (p_event IS NOT NULL AND EXISTS (
            SELECT 1 FROM crove_kernel.notification x
             WHERE x.org_id = p_org AND x.user_id = p_author AND x.kind = 'kernel.personal_data_notice'
               AND x.dedupe_key = 'personal_data_notice:' || p_event
               AND x.created_at <= pg_catalog.now() - interval '24 hours'))
$$;
REVOKE ALL ON FUNCTION crove_notes.private_notice_told(uuid, uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_notes.private_erase(p_kind text, p_value text)
RETURNS TABLE (author_user_id uuid, notes bigint, todos bigint, untold_notes bigint, untold_todos bigint, note_ids uuid[], todo_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_key text;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'NOTES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_notes.private_notice_key_of(v_org, p_kind, p_value);
  RETURN QUERY
    WITH told AS (
      -- The notices of this org written at least 24 hours before this transaction.
      SELECT a.detail, a.actor_id FROM crove_kernel.audit_event a
       WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
         AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
         AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'key' = v_key
    ),
    note_found AS (
      SELECT n.id, n.revision, n.author_user_id AS author,
             EXISTS (SELECT 1 FROM told
                      WHERE pg_catalog.jsonb_typeof(told.detail -> 'notes') = 'array' AND (told.detail -> 'notes') ? (n.id::text || ':' || n.revision::text)
                        AND crove_notes.private_notice_told(v_org, n.author_user_id, told.actor_id, told.detail ->> 'event')) AS named
        FROM crove_notes.note n
       WHERE n.org_id = v_org AND n.visibility = 'private'
         AND (crove_kernel.text_mentions(n.title, p_kind, p_value)
              OR crove_kernel.text_mentions(n.body, p_kind, p_value)
              OR crove_kernel.text_mentions(pg_catalog.array_to_string(n.tags, ' '), p_kind, p_value))
    ),
    todo_found AS (
      SELECT t.id, t.revision, t.owner_user_id AS author,
             EXISTS (SELECT 1 FROM told
                      WHERE pg_catalog.jsonb_typeof(told.detail -> 'todos') = 'array' AND (told.detail -> 'todos') ? (t.id::text || ':' || t.revision::text)
                        AND crove_notes.private_notice_told(v_org, t.owner_user_id, told.actor_id, told.detail ->> 'event')) AS named
        FROM crove_notes.todo t
       WHERE t.org_id = v_org
         AND (crove_kernel.text_mentions(t.title, p_kind, p_value)
              OR crove_kernel.text_mentions(t.details, p_kind, p_value)
              OR crove_kernel.text_mentions(t.checklist::text, p_kind, p_value))
    ),
    note_gone AS (
      -- The revision again on the row deleted: one an author changes while this runs (the DELETE waits for their
      -- commit and reads the row anew) is not the one the notice named, and stays.
      DELETE FROM crove_notes.note n USING note_found f
       WHERE n.org_id = v_org AND n.id = f.id AND n.revision = f.revision AND f.named
      RETURNING n.id, f.author
    ),
    todo_gone AS (
      DELETE FROM crove_notes.todo t USING todo_found f
       WHERE t.org_id = v_org AND t.id = f.id AND t.revision = f.revision AND f.named
      RETURNING t.id, f.author
    ),
    counted AS (
      SELECT g.author, g.id, 'note'::text AS kind, true AS gone FROM note_gone g
      UNION ALL SELECT g.author, g.id, 'todo', true FROM todo_gone g
      UNION ALL SELECT f.author, f.id, 'note', false FROM note_found f WHERE NOT EXISTS (SELECT 1 FROM note_gone g WHERE g.id = f.id)
      UNION ALL SELECT f.author, f.id, 'todo', false FROM todo_found f WHERE NOT EXISTS (SELECT 1 FROM todo_gone g WHERE g.id = f.id)
    )
    -- The deleted ids, for the erasure's audit row: ids only.
    SELECT c.author,
           pg_catalog.count(*) FILTER (WHERE c.kind = 'note' AND c.gone),
           pg_catalog.count(*) FILTER (WHERE c.kind = 'todo' AND c.gone),
           pg_catalog.count(*) FILTER (WHERE c.kind = 'note' AND NOT c.gone),
           pg_catalog.count(*) FILTER (WHERE c.kind = 'todo' AND NOT c.gone),
           COALESCE(pg_catalog.array_agg(c.id ORDER BY c.id) FILTER (WHERE c.kind = 'note' AND c.gone), '{}'::uuid[]),
           COALESCE(pg_catalog.array_agg(c.id ORDER BY c.id) FILTER (WHERE c.kind = 'todo' AND c.gone), '{}'::uuid[])
      FROM counted c
     GROUP BY c.author
     ORDER BY c.author;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_erase(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_erase(text, text) TO crove_tenant;
