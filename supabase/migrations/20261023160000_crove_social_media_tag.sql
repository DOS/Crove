-- Crove Social: tags on media library files (issue #904). Idempotent; applied files stay untouched.
--
-- crove_social.media_tag  a tag a member puts on a library file (a product, a campaign, a client's brand) to find it
--                         again. crove_kernel.file never changes, so the tags live here. The commands normalize a tag
--                         (trimmed, inner spaces collapsed, case kept), allow one spelling per file compared without
--                         case and at most 20 per file. Tags go with their file (the foreign key cascades).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.media_tag (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  file_id uuid NOT NULL,
  tag text NOT NULL CHECK (length(tag) BETWEEN 1 AND 40 AND tag = btrim(tag)),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT media_tag_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) ON DELETE CASCADE
);
-- One spelling of a tag per file, whatever its case.
CREATE UNIQUE INDEX IF NOT EXISTS media_tag_file_tag_uq ON crove_social.media_tag (org_id, file_id, lower(tag));
-- The library's tag filter and the tag counts look files up by tag.
CREATE INDEX IF NOT EXISTS media_tag_tag_idx ON crove_social.media_tag (org_id, lower(tag), file_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.media_tag');
-- Tags are added and removed, never changed in place.
REVOKE UPDATE ON crove_social.media_tag FROM crove_tenant;
