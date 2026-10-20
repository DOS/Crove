-- Crove Social: a post's assignee and due date (issue #640). Idempotent.
--
-- assignee_user_id  the member who should move the post along (write it, fix it, get it approved); NULL: nobody.
--                   Kept when they leave the org (the screen then shows a former member), like author_user_id.
-- due_at            when the post should be ready; a post past it and not out is shown as overdue.
-- Owners, admins and the post's author set them through social.post.assign; they are not content, so they never
-- change the revision or a channel's approval.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS assignee_user_id uuid;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS due_at timestamptz;
CREATE INDEX IF NOT EXISTS post_assignee_idx ON crove_social.post (org_id, assignee_user_id, updated_at DESC) WHERE assignee_user_id IS NOT NULL;