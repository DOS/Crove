-- Crove Social: the version history of a post, to go back after a bad edit (issue #1021). Idempotent; applied files
-- stay untouched.
--
-- crove_social.post_version  the content of a post as one save left it: the post's text, title, link and images (file
--                            ids with their descriptions, in order), and each channel's overrides, settings and own
--                            images (variants, as the commands write it). social.post.update and social.variant.update
--                            append one when a save changes that content, and social.post.restore_version appends the
--                            restored content as a new edit. The first save of a post that has no version yet also
--                            keeps the content before it, as number 1 with no author. number counts the post's
--                            versions from 1, under the post's row lock; revision is the post's revision then. The
--                            commands keep the newest 50 per post and delete older ones in the same transaction.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.post_version (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  number int NOT NULL CHECK (number >= 1),
  revision int NOT NULL CHECK (revision >= 1),
  body text NOT NULL CHECK (length(body) <= 100000),
  title text CHECK (title IS NULL OR length(title) <= 500),
  link_url text CHECK (link_url IS NULL OR length(link_url) <= 2000),
  -- [{fileId, altText}] in order.
  media jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(media) = 'array'),
  -- [{variantId, connectionId, provider, body, title, linkUrl, settings, media, contentFrozen}], media null to inherit.
  variants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(variants) = 'array'),
  -- Who saved it; null for the content a post had before its first saved version.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT post_version_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE
);
-- One number per version of a post; the list reads a post's versions newest first, and the prune drops the oldest.
CREATE UNIQUE INDEX IF NOT EXISTS post_version_number_uq ON crove_social.post_version (org_id, post_id, number);
SELECT crove_kernel.apply_tenant_rls('crove_social.post_version');
-- A version is never changed: it is appended, and deleted only by the commands' prune past the newest 50.
REVOKE UPDATE ON crove_social.post_version FROM crove_tenant;
