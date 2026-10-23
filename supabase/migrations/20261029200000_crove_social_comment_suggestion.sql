-- Suggested edits (#1236): a member who may comment on a post selects words of its text, or of a channel's own text,
-- and suggests other words; a member who may edit the post accepts the suggestion, which saves the change through the
-- ordinary edit (a new revision and version, the review again), or skips it. A suggestion is a comment with these
-- columns set. Idempotent; applied files stay untouched.
--
-- suggest_field  the text the suggestion changes: 'post', the post's own text (crove_social.post.body), or
--                'channel', the own text of the comment's channel (crove_social.post_variant.body). A channel
--                suggestion whose channel was taken off the post (variant_id set to NULL) can no longer be applied.
-- suggest_start, suggest_end
--                where the quoted words were in that text when the suggestion was made, as offsets in UTF-16 code
--                units (as the browser and the server count them); end > start.
-- suggest_quote  the words selected, as they were there (1 to 4000 characters).
-- suggest_text   the words suggested instead (0 to 4000 characters: an empty one deletes the quote), never the same.
-- suggest_hash   sha256 of the whole text the suggestion was made against.
-- suggest_state  open; accepted (applied by social.post_comment.accept); skipped, or outdated (closed by
--                social.post_comment.skip when the quote was no longer in the text). A closed suggestion is resolved
--                (resolved_at and resolved_by set) and an open one is not.
--
-- A suggestion is never pinned (#1180), and carries all seven columns or none. Its note (body) may be empty. The
-- suggestion is written once, by social.post_comment.suggest: crove_tenant inserts these columns (table INSERT) and
-- may update only suggest_state, which the accept and skip commands set with resolved_at and resolved_by.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_field text;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_start integer;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_end integer;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_quote text;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_text text;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_hash text;
ALTER TABLE crove_social.post_comment ADD COLUMN IF NOT EXISTS suggest_state text;

-- NOT VALID: added without scanning the table under its lock; validated below (every existing row has the new columns
-- NULL and a body of 1 to 4000 characters).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_suggest_field_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_suggest_field_check
      CHECK (suggest_field IN ('post', 'channel')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_suggest_state_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_suggest_state_check
      CHECK (suggest_state IN ('open', 'accepted', 'skipped', 'outdated')) NOT VALID;
  END IF;
  -- All seven or none; a range inside a post's text (100000 characters at most), a quote and a replacement of at most
  -- 4000 characters that differ, the hash's form, and no pin with it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_suggest_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_suggest_check
      CHECK (
        (suggest_field IS NULL AND suggest_start IS NULL AND suggest_end IS NULL AND suggest_quote IS NULL
          AND suggest_text IS NULL AND suggest_hash IS NULL AND suggest_state IS NULL)
        OR (suggest_field IS NOT NULL AND suggest_start IS NOT NULL AND suggest_end IS NOT NULL AND suggest_quote IS NOT NULL
          AND suggest_text IS NOT NULL AND suggest_hash IS NOT NULL AND suggest_state IS NOT NULL
          AND suggest_start >= 0 AND suggest_end > suggest_start AND suggest_end <= 100000
          AND length(suggest_quote) BETWEEN 1 AND 4000 AND length(suggest_text) <= 4000 AND suggest_quote <> suggest_text
          AND suggest_hash ~ '^sha256:[0-9a-f]{64}$'
          AND file_id IS NULL)
      ) NOT VALID;
  END IF;
  -- Closed exactly when resolved.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_suggest_resolved_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_suggest_resolved_check
      CHECK (suggest_state IS NULL OR (suggest_state = 'open') = (resolved_at IS NULL)) NOT VALID;
  END IF;
  -- The note of a suggestion may be empty; any other comment keeps 1 to 4000 characters (20261020220000).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_comment'::regclass AND conname = 'post_comment_note_check'
  ) THEN
    ALTER TABLE crove_social.post_comment ADD CONSTRAINT post_comment_note_check
      CHECK (length(body) <= 4000 AND (length(body) >= 1 OR suggest_field IS NOT NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_suggest_field_check;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_suggest_state_check;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_suggest_check;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_suggest_resolved_check;
ALTER TABLE crove_social.post_comment VALIDATE CONSTRAINT post_comment_note_check;
-- Replaced by post_comment_note_check, which keeps the same bounds for every comment but a suggestion.
ALTER TABLE crove_social.post_comment DROP CONSTRAINT IF EXISTS post_comment_body_check;

-- Added to the columns the edit and resolve commands write (20261020220000, 20261029120000); the table stays without
-- DELETE, and the suggestion's own columns are never changed.
GRANT UPDATE (suggest_state) ON crove_social.post_comment TO crove_tenant;
