-- Supporting indexes for Social's tenant foreign keys that had none (#1212, found by the G3 conformance test, #1200):
-- without them, deleting a post, a variant or a file (the org purge, #1024) scans the child table. Existing indexes
-- missed: post_variant has only a partial unique index on live variants, and the variant indexes of post_approval and
-- post_comment do not cover post_id, the third column of their composite key to (org_id, id, post_id). Nullable keys
-- get an index partial on the key being set, since a NULL key is never checked. Idempotent; no data changes.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS notification_post_idx
  ON crove_social.notification (org_id, post_id) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_approval_variant_post_idx ON crove_social.post_approval (org_id, variant_id, post_id);
CREATE INDEX IF NOT EXISTS post_variant_post_idx ON crove_social.post_variant (org_id, post_id);
CREATE INDEX IF NOT EXISTS watermark_file_idx ON crove_social.watermark (org_id, file_id);

-- Replaces post_comment_variant_idx, a prefix of it with the same predicate, so writes keep one index and not two.
-- Dropped first: its ACCESS EXCLUSIVE lock then covers the build, instead of upgrading from the build's SHARE lock,
-- which can deadlock with a transaction already waiting on the table.
DROP INDEX IF EXISTS crove_social.post_comment_variant_idx;
CREATE INDEX IF NOT EXISTS post_comment_variant_post_idx
  ON crove_social.post_comment (org_id, variant_id, post_id) WHERE variant_id IS NOT NULL;
