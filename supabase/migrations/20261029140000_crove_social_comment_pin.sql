-- Pinned internal comments (#1180): a comment on a post can point at a spot on one of its images or a moment in one
-- of its videos, so "the logo here" and "the text at 0:12" name what they mean. Idempotent; applied files stay
-- untouched.
--
-- file_id      the image or video the comment is pinned to; NULL: not pinned. A file of the comment's own org (the
--              composite foreign key), and, as social.post_comment.add checks, among the post's media or the
--              comment's channel's own media when it was written. A file a pin names cannot be deleted from under it
--              (NO ACTION, as crove_social.post_media); crove_kernel.file never changes, and the org purge deletes
--              every post_comment before the files.
-- pin_x, pin_y the spot on an image, each 0..1 of its width and height from the top left; both or neither.
-- pin_seconds  the moment in a video, in seconds from its start (at most a day).
--
-- A pinned comment has a file and exactly one of the two; an unpinned one has neither. The pin is written once, by
-- social.post_comment.add: crove_tenant inserts these columns (table INSERT) and gets no UPDATE on them, so the
-- column grants stay UPDATE (body, edited_at) and UPDATE (resolved_at, resolved_by).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS file_id uuid;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS pin_x real;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS pin_y real;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS pin_seconds real;

-- NOT VALID: added without scanning the table under its lock; validated below (every existing row has all four NULL).
-- BETWEEN refuses NaN (greater than every number in PostgreSQL) and the infinities; the IS NOT NULL tests keep a
-- half-set spot from passing as unknown.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_file_fk'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_file_fk
      FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_pin_xy_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_pin_xy_check
      CHECK (
        (pin_x IS NULL AND pin_y IS NULL)
        OR (pin_x IS NOT NULL AND pin_y IS NOT NULL AND pin_x BETWEEN 0 AND 1 AND pin_y BETWEEN 0 AND 1)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_pin_seconds_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_pin_seconds_check
      CHECK (pin_seconds IS NULL OR pin_seconds BETWEEN 0 AND 86400) NOT VALID;
  END IF;
  -- A file with exactly one pin (a spot or a moment), or neither.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_pin_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_pin_check
      CHECK (
        (file_id IS NULL AND pin_x IS NULL AND pin_seconds IS NULL)
        OR (file_id IS NOT NULL AND (pin_x IS NULL) <> (pin_seconds IS NULL))
      ) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_file_fk;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_pin_xy_check;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_pin_seconds_check;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_pin_check;

-- The foreign key's referencing side, for a delete of a file (the org purge) and the comments pinned to one file.
CREATE INDEX IF NOT EXISTS post_comment_file_idx ON crove_social.post_comment (org_id, file_id) WHERE file_id IS NOT NULL;
