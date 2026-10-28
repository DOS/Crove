-- Crove Notes (issue #1671, plan docs/plan/notes.md §3.4 and §3.6, ADR-0037): members' notes, private to their
-- author or shared with the org, and their links to records. Idempotent; applied files stay untouched.
--
-- crove_notes.note  a note: title, Markdown body and tags, private (its author alone) or shared ('org'). Its author
--                   is the caller, checked against the sealed context's user, and never changes; there is no foreign
--                   key to tenant_member, so a member's notes outlive their removal (ADR-0037 §4). A deleted note sits
--                   in the trash (deleted_at) for 30 days, then crove_notes.trash_empty removes it.
-- crove_notes.link  a note linked to one record: a party or a file in this step (target_type), each with a foreign
--                   key so the link goes with its record. A link reads through its note's policies, and only the
--                   note's author adds or removes one. N4 adds to-dos as a second parent.
--
-- Who reads what (ADR-0037 §2): a private note only in a context whose user is its author; a shared note also by
-- owners, admins and members whose scope is the whole org (le_scope '*'), and by the system context (the export);
-- viewers, members limited to some legal entities and agent contexts read none. The system context writes nothing:
-- the worker reaches private rows only through the definers below, which return ids and counts, never text, and the
-- org purge deletes every note as the table owner.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_notes;
GRANT USAGE ON SCHEMA crove_notes TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_notes.note (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  author_user_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
  title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (pg_catalog.length(body) <= 100000),
  -- At most 20; each 1 to 40 lower-case characters, which the commands check.
  tags text[] NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(tags) <= 20),
  pinned boolean NOT NULL DEFAULT false,
  -- Text that came from AI or untrusted content (N8); nothing sets it yet.
  tainted boolean NOT NULL DEFAULT false,
  -- The title, tags and body folded for search (crove_kernel.search_vector), set by the trigger below.
  search tsvector NOT NULL DEFAULT ''::tsvector,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (org_id, id)
);
-- A member's notes, newest first; the trash sweep; search.
CREATE INDEX IF NOT EXISTS note_author_idx ON crove_notes.note (org_id, author_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS note_deleted_idx ON crove_notes.note (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS note_search_idx ON crove_notes.note USING gin (search);
SELECT crove_kernel.apply_tenant_rls('crove_notes.note');
-- The author, the org and the creation time never change; nothing deletes a note but the definers and the purge.
REVOKE UPDATE, DELETE ON crove_notes.note FROM crove_tenant;
GRANT UPDATE (visibility, title, body, tags, pinned, tainted, search, revision, updated_at, archived_at, deleted_at) ON crove_notes.note TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.note_search() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.search := crove_kernel.search_vector(NEW.title || ' ' || pg_catalog.array_to_string(NEW.tags, ' ') || ' ' || NEW.body);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.note_search() FROM PUBLIC;
DROP TRIGGER IF EXISTS b_search ON crove_notes.note;
CREATE TRIGGER b_search BEFORE INSERT OR UPDATE OF title, body, tags ON crove_notes.note
  FOR EACH ROW EXECUTE FUNCTION crove_notes.note_search();

CREATE TABLE IF NOT EXISTS crove_notes.link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  note_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('kernel.party', 'kernel.file')),
  target_id uuid NOT NULL,
  -- The target again, in the column of its type, so it has a foreign key.
  party_id uuid,
  file_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT link_target_ck CHECK (
    (target_type = 'kernel.party' AND party_id = target_id AND file_id IS NULL)
    OR (target_type = 'kernel.file' AND file_id = target_id AND party_id IS NULL)),
  CONSTRAINT link_note_fk FOREIGN KEY (org_id, note_id) REFERENCES crove_notes.note (org_id, id) ON DELETE CASCADE,
  CONSTRAINT link_party_fk FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE CASCADE,
  CONSTRAINT link_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE
);
-- One link per note and record; it also backs the note foreign key (G3).
CREATE UNIQUE INDEX IF NOT EXISTS link_note_target_uq ON crove_notes.link (org_id, note_id, target_type, target_id);
-- A record's panel.
CREATE INDEX IF NOT EXISTS link_target_idx ON crove_notes.link (org_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS link_party_idx ON crove_notes.link (org_id, party_id);
CREATE INDEX IF NOT EXISTS link_file_idx ON crove_notes.link (org_id, file_id);
SELECT crove_kernel.apply_tenant_rls('crove_notes.link');
-- A link is added or removed, never changed.
REVOKE UPDATE ON crove_notes.link FROM crove_tenant;

-- Restrictive, so they narrow the tenant policy and never widen it.
DROP POLICY IF EXISTS note_read ON crove_notes.note;
CREATE POLICY note_read ON crove_notes.note AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (visibility = 'org' AND (
      -- The system context (no user, no agent): the export reads shared notes.
      ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
      -- Owners, admins and members whose scope is the whole org; not viewers, not members limited to some entities.
      OR ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))))));
DROP POLICY IF EXISTS note_insert ON crove_notes.note;
CREATE POLICY note_insert ON crove_notes.note AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (author_user_id = (SELECT crove_kernel.ctx_user_id()));
-- The author changes their own notes; owners and admins also change a shared note (the commands limit them to pin,
-- archive and delete: a row policy cannot limit columns). Neither moves a note's visibility for someone else: a shared
-- note an owner changes stays shared.
DROP POLICY IF EXISTS note_update ON crove_notes.note;
CREATE POLICY note_update ON crove_notes.note AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (visibility = 'org' AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))))
  WITH CHECK (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (visibility = 'org' AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))));

-- A link reads through its note, whose own policies apply to the subquery; only the note's author writes one.
DROP POLICY IF EXISTS link_read ON crove_notes.link;
CREATE POLICY link_read ON crove_notes.link AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id));
DROP POLICY IF EXISTS link_insert ON crove_notes.link;
CREATE POLICY link_insert ON crove_notes.link AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (EXISTS (
    SELECT 1 FROM crove_notes.note n
    WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())));
DROP POLICY IF EXISTS link_delete ON crove_notes.link;
CREATE POLICY link_delete ON crove_notes.link AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (EXISTS (
    SELECT 1 FROM crove_notes.note n
    WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())));

-- Stream hints (#69): the id of a changed note reaches the org's open apps, which refetch through these policies.
DROP TRIGGER IF EXISTS stream_hint ON crove_notes.note;
-- The kernel's stream hint function, as every table that sends hints uses it.
CREATE TRIGGER stream_hint AFTER INSERT OR UPDATE ON crove_notes.note
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.stream_notify('note', 'id');

-- ---------------------------------------------------------------------------
-- Definers (ADR-0037 §2). None returns a title, body or tag.
-- ---------------------------------------------------------------------------

-- The orgs with notes in the trash since before p_before, for the daily sweep (worker login only, no context).
CREATE OR REPLACE FUNCTION crove_notes.trash_due(p_before timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT DISTINCT n.org_id FROM crove_notes.note n
    WHERE n.deleted_at IS NOT NULL AND n.deleted_at < p_before
    ORDER BY 1 LIMIT pg_catalog.least(pg_catalog.greatest(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_due(timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_due(timestamptz, integer) TO crove_worker;

-- Removes the context's org's notes in the trash since before p_before, private ones included (worker login, in the
-- org's system context: notes.trash.empty). Returns how many.
CREATE OR REPLACE FUNCTION crove_notes.trash_empty(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.deleted_at IS NOT NULL AND n.deleted_at < p_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_notes.trash_empty(timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.trash_empty(timestamptz) TO crove_worker;

-- Removes a former member's private notes from the context's org, unless they are a member again (worker login, in
-- the org's system context: notes.member_items.purge, 30 days after the removal). Their shared notes stay with the
-- org. Returns how many it removed.
CREATE OR REPLACE FUNCTION crove_notes.member_items_purge(p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
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
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_notes.member_items_purge(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.member_items_purge(uuid) TO crove_worker;

-- How many private notes each author has in the context's org, outside the trash: for an owner or admin before they
-- remove a member (the members screen), and for the org export, which runs in the system context and records the count
-- of what its row policies leave out. No other context gets an answer.
CREATE OR REPLACE FUNCTION crove_notes.private_counts()
RETURNS TABLE (org_id uuid, author_user_id uuid, notes bigint) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
  RETURN QUERY SELECT n.org_id, n.author_user_id, pg_catalog.count(*)
    FROM crove_notes.note n
    WHERE n.org_id = v_org AND n.visibility = 'private' AND n.deleted_at IS NULL
    GROUP BY n.org_id, n.author_user_id
    ORDER BY n.author_user_id;
END $$;
REVOKE ALL ON FUNCTION crove_notes.private_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.private_counts() TO crove_tenant;

-- The worker's queues (apps/kernel/src/notes-worker.ts): the purge of a former member's private notes, queued 30 days
-- after the removal (singleton key <org>:<user>:<event>), and the daily trash sweep.
SELECT crove_jobs.create_queue('notes-member-purge', '{"policy":"standard"}'::jsonb);
SELECT crove_jobs.create_queue('notes-trash', '{"policy":"standard"}'::jsonb);
