-- PROBE ONLY, never merged: an ADR-0037-shaped crove_notes schema, to run the RLS matrix's AUTHOR_ONLY exceptions
-- of #1670 against real policies before N2 exists.
SET LOCAL lock_timeout = '2s';
CREATE SCHEMA IF NOT EXISTS crove_notes;
GRANT USAGE ON SCHEMA crove_notes TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_notes.note (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  author_user_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_notes.note');

CREATE TABLE IF NOT EXISTS crove_notes.todo (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  owner_user_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'open',
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  sort_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_notes.todo');

CREATE TABLE IF NOT EXISTS crove_notes.link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  note_id uuid,
  todo_id uuid,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  party_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CHECK ((note_id IS NULL) <> (todo_id IS NULL)),
  FOREIGN KEY (org_id, note_id) REFERENCES crove_notes.note (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, todo_id) REFERENCES crove_notes.todo (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id)
);
CREATE INDEX IF NOT EXISTS link_note_idx ON crove_notes.link (org_id, note_id);
CREATE INDEX IF NOT EXISTS link_todo_idx ON crove_notes.link (org_id, todo_id);
CREATE INDEX IF NOT EXISTS link_party_idx ON crove_notes.link (org_id, party_id);
SELECT crove_kernel.apply_tenant_rls('crove_notes.link');

DROP POLICY IF EXISTS note_read ON crove_notes.note;
CREATE POLICY note_read ON crove_notes.note AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (visibility = 'org' AND (
      ((SELECT crove_kernel.ctx_user_id()) IS NULL AND (SELECT crove_kernel.ctx_agent_id()) IS NULL)
      OR ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))))));
DROP POLICY IF EXISTS note_insert ON crove_notes.note;
CREATE POLICY note_insert ON crove_notes.note AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (author_user_id = (SELECT crove_kernel.ctx_user_id()));
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
DROP POLICY IF EXISTS note_delete ON crove_notes.note;
CREATE POLICY note_delete ON crove_notes.note AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    author_user_id = (SELECT crove_kernel.ctx_user_id())
    OR (visibility = 'org' AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
      WHERE m.org_id = note.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin'))));

DROP POLICY IF EXISTS todo_owner ON crove_notes.todo;
CREATE POLICY todo_owner ON crove_notes.todo AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (owner_user_id = (SELECT crove_kernel.ctx_user_id()))
  WITH CHECK (owner_user_id = (SELECT crove_kernel.ctx_user_id()));

DROP POLICY IF EXISTS link_read ON crove_notes.link;
CREATE POLICY link_read ON crove_notes.link AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id)
    OR EXISTS (SELECT 1 FROM crove_notes.todo d WHERE d.org_id = link.org_id AND d.id = link.todo_id));
DROP POLICY IF EXISTS link_write ON crove_notes.link;
CREATE POLICY link_write ON crove_notes.link AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id()))
    OR EXISTS (SELECT 1 FROM crove_notes.todo d WHERE d.org_id = link.org_id AND d.id = link.todo_id AND d.owner_user_id = (SELECT crove_kernel.ctx_user_id())));
DROP POLICY IF EXISTS link_update ON crove_notes.link;
CREATE POLICY link_update ON crove_notes.link AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id()))
    OR EXISTS (SELECT 1 FROM crove_notes.todo d WHERE d.org_id = link.org_id AND d.id = link.todo_id AND d.owner_user_id = (SELECT crove_kernel.ctx_user_id())))
  WITH CHECK (
    EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id()))
    OR EXISTS (SELECT 1 FROM crove_notes.todo d WHERE d.org_id = link.org_id AND d.id = link.todo_id AND d.owner_user_id = (SELECT crove_kernel.ctx_user_id())));
DROP POLICY IF EXISTS link_delete ON crove_notes.link;
CREATE POLICY link_delete ON crove_notes.link AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    EXISTS (SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id()))
    OR EXISTS (SELECT 1 FROM crove_notes.todo d WHERE d.org_id = link.org_id AND d.id = link.todo_id AND d.owner_user_id = (SELECT crove_kernel.ctx_user_id())));
