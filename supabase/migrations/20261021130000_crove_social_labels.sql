-- Crove Social: labels for posts (issue #639). Idempotent.
--
-- label       a named tag an org puts on posts to sort them by campaign, client or topic, with a colour from the
--             app's palette. Members create them; owners and admins rename, recolour and delete them (the commands
--             check who). Deleting one takes it off every post.
-- post_label  a label on a post. Replaced as a whole by social.post.set_labels; not part of a post's content, so it
--             never changes a revision, a content hash or an approval.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.label (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  color text NOT NULL DEFAULT 'gray' CHECK (color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS label_name_uq ON crove_social.label (org_id, lower(name));
SELECT crove_kernel.apply_tenant_rls('crove_social.label');
-- Who made it and when stay as they were.
REVOKE UPDATE ON crove_social.label FROM crove_tenant;
GRANT UPDATE (name, color) ON crove_social.label TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_social.post_label (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  label_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT post_label_uq UNIQUE (org_id, post_id, label_id),
  CONSTRAINT post_label_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE,
  CONSTRAINT post_label_label_fk FOREIGN KEY (org_id, label_id) REFERENCES crove_social.label (org_id, id) ON DELETE CASCADE
);
-- The list filter and the label counts look posts up by label.
CREATE INDEX IF NOT EXISTS post_label_label_idx ON crove_social.post_label (org_id, label_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.post_label');
-- A post's labels are inserted and deleted, never changed in place.
REVOKE UPDATE ON crove_social.post_label FROM crove_tenant;
