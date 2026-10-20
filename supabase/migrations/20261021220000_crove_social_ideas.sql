-- The Social ideas board (issue #701). Idempotent; applied files stay untouched.
--
-- idea        an idea for a post before it is one: a title, an optional note and link, images or videos of the media
--             library, and a stage (new, planned, drafted, archived). Members add and move ideas; "turn into a
--             draft" makes a post from it (social.post.create with ideaId), links the post here and moves the idea to
--             drafted. Ideas are archived, never deleted by a member; a deleted post leaves the idea without its link.
-- idea_label  a label of the org's post labels on an idea, copied onto the draft made from it. Replaced as a whole.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.idea (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 5000),
  link_url text CHECK (link_url IS NULL OR length(link_url) BETWEEN 1 AND 2000),
  -- Files of the media library, in order; checked by the commands (the org's own Social files).
  file_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(file_ids) <= 10),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'planned', 'drafted', 'archived')),
  -- The draft made from it.
  post_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT idea_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE SET NULL (post_id)
);
CREATE INDEX IF NOT EXISTS idea_stage_idx ON crove_social.idea (org_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idea_post_idx ON crove_social.idea (org_id, post_id) WHERE post_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_social.idea');
REVOKE DELETE ON crove_social.idea FROM crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.idea_label (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  idea_id uuid NOT NULL,
  label_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT idea_label_uq UNIQUE (org_id, idea_id, label_id),
  CONSTRAINT idea_label_idea_fk FOREIGN KEY (org_id, idea_id) REFERENCES crove_social.idea (org_id, id) ON DELETE CASCADE,
  CONSTRAINT idea_label_label_fk FOREIGN KEY (org_id, label_id) REFERENCES crove_social.label (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idea_label_label_idx ON crove_social.idea_label (org_id, label_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.idea_label');
-- An idea's labels are inserted and deleted, never changed in place.
REVOKE UPDATE ON crove_social.idea_label FROM crove_tenant;
