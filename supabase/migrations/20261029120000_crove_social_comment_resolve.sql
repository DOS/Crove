-- Resolved internal comments (#1168): a member marks a comment on a post as dealt with, or opens it again, so over
-- several rounds of review everyone sees which notes are still open. Nothing is deleted; the thread stays a record.
-- Idempotent.
--
-- resolved_at, resolved_by  when and by whom the comment was resolved; both NULL while it is open. Only the commands
--                           social.post_comment.resolve and .reopen write them (they decide who may), and neither touches
--                           the text: the edit window and its author rule stay in social.post_comment.edit.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS resolved_by uuid;

-- Both or neither. NOT VALID: added without scanning the table under its exclusive lock; validated below (every
-- existing row has both NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_resolved_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_resolved_check
      CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_resolved_check;

-- The open comments of a post, counted for its lists and its review (one grouped count per page of posts).
CREATE INDEX IF NOT EXISTS post_comment_open_idx ON crove_social.post_comment (org_id, post_id) WHERE resolved_at IS NULL;

-- Added to the text columns the edit command writes (20261020220000); the table stays without DELETE.
GRANT UPDATE (resolved_at, resolved_by) ON crove_social.post_comment TO crove_tenant;
