-- Crove Social: remind a post's assignee before its due date and when it is overdue (issue #1359). Idempotent; applied
-- files stay untouched.
--
-- crove_social.post.due_soon_reminded_at  when the assignee was reminded that the post is due within 24 hours;
-- crove_social.post.overdue_reminded_at   when they were reminded that it is past its due date and not out yet.
--                                         Each is set once by the worker's command (social.post.remind_due) under the
--                                         post lock; social.post.assign (also inside social.post.bulk_assign) clears
--                                         both when the due date or the assignee changes, so each reminder goes once
--                                         per due date and assignee.
-- notification kind assignment_due        in the app, by email and as browser push, and a member can turn it off like
--                                         the other kinds.
-- crove_social.assignment_reminders_due   the worker's scan, across orgs, of posts with a reminder due, in the pattern
--                                         of review_reminders_due: ids only, active orgs, an assignee who is still a
--                                         member with an account that is not disabled, a post that is neither out
--                                         (published, partly published or publishing), cancelled nor archived. The
--                                         worker login alone may run it.
--
-- No new table: the reminder runs in the org's system context and reads only the org's own rows.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS due_soon_reminded_at timestamptz;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS overdue_reminded_at timestamptz;

-- A post already past its due date when this runs counts as reminded: a first reminder of a date long gone would only
-- be noise. Its next due date or assignee arms both again.
UPDATE crove_social.post
SET overdue_reminded_at = pg_catalog.now(), due_soon_reminded_at = coalesce(due_soon_reminded_at, pg_catalog.now())
WHERE assignee_user_id IS NOT NULL AND due_at IS NOT NULL AND due_at <= pg_catalog.now() AND overdue_reminded_at IS NULL;

-- The scan's posts: assigned, with a due date, not archived.
CREATE INDEX IF NOT EXISTS post_due_reminder_idx ON crove_social.post (due_at)
  WHERE assignee_user_id IS NOT NULL AND due_at IS NOT NULL AND archived_at IS NULL;

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below. The list is
-- the one of 20261029080000_crove_social_outperforming.sql with assignment_due added.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%assignment_due%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'', ''feed_paused'', ''mention'', ''publishing_hold'', ''queue_low'', ''weekly_digest'', ''post_outperforming'', ''assignment_due'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;

-- Posts of active orgs whose assignee is still a member with an active account, not out, cancelled or archived, with
-- a reminder not sent yet: past the due date, or the due date less than 24 hours away. Soonest due date first.
CREATE OR REPLACE FUNCTION crove_social.assignment_reminders_due(p_limit int)
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_social.post p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  JOIN crove_kernel.tenant_member m ON m.org_id = p.org_id AND m.user_id = p.assignee_user_id
  JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
  WHERE p.assignee_user_id IS NOT NULL
    AND p.due_at IS NOT NULL
    AND p.archived_at IS NULL
    AND p.status IN ('draft', 'scheduled', 'failed')
    AND (
      (p.overdue_reminded_at IS NULL AND p.due_at <= pg_catalog.now())
      OR (p.due_soon_reminded_at IS NULL AND p.due_at > pg_catalog.now() AND p.due_at <= pg_catalog.now() + interval '24 hours')
    )
  ORDER BY p.due_at, p.org_id, p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.assignment_reminders_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.assignment_reminders_due(int) TO crove_worker;
