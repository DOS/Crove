-- Crove Social: archived posts (issue #1299). Idempotent; applied files stay untouched. Columns only, no table.
--
-- crove_social.post.archived_at  when a person archived the post (social.post.archive); NULL: not archived. An
--                                archived post leaves every list, calendar, board, inbox and export of the app and
--                                comes back unchanged with social.post.restore, which sets both columns back to NULL.
-- crove_social.post.archived_by  who archived it. A plain uuid like author_user_id, assignee_user_id and every other
--                                *_by column of the Social tables: kept when the person leaves the org, so no foreign
--                                key (one to crove_kernel.tenant_member would either delete the post with the
--                                membership or have to forget who archived it).
-- post_archived_pair             both set, or neither.
-- post_live_idx                  the lists read posts that are not archived, newest change first.
--
-- Grants as the table's other columns: crove_tenant keeps its table-level SELECT, INSERT and UPDATE (DELETE stays
-- revoked), and the commands are what decide who archives which post.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS archived_by uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_archived_pair') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_archived_pair CHECK ((archived_at IS NULL) = (archived_by IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS post_live_idx ON crove_social.post (org_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;
