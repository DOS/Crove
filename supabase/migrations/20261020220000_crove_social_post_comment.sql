-- Crove Social: internal comments on a post (issue #582). Idempotent.
--
-- post_comment  a note a member leaves on a post, or on one of its channels (variant_id). Internal: never published,
--               never part of the content hash or an approval. Its author may change the text for a few minutes
--               (social.post_comment.edit checks the window); nobody deletes one, so the thread stays a record.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.post_comment (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  -- The channel the comment is about; NULL: the whole post. A channel taken off a draft keeps its comments on the post.
  variant_id uuid,
  author_user_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  PRIMARY KEY (org_id, id),
  CONSTRAINT post_comment_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE,
  -- The comment's channel belongs to the comment's post.
  CONSTRAINT post_comment_variant_fk FOREIGN KEY (org_id, variant_id, post_id) REFERENCES crove_social.post_variant (org_id, id, post_id)
    ON DELETE SET NULL (variant_id)
);
CREATE INDEX IF NOT EXISTS post_comment_post_idx ON crove_social.post_comment (org_id, post_id, created_at);
CREATE INDEX IF NOT EXISTS post_comment_variant_idx ON crove_social.post_comment (org_id, variant_id) WHERE variant_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_social.post_comment');
-- Only the text changes, and only through the edit command; nothing is deleted.
REVOKE UPDATE, DELETE ON crove_social.post_comment FROM crove_tenant;
GRANT UPDATE (body, edited_at) ON crove_social.post_comment TO crove_tenant;
