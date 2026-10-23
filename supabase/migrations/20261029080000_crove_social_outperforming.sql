-- Crove Social: tell the author when a post does much better than usual (issue #1132). Idempotent; applied files stay
-- untouched.
--
-- crove_social.post_variant.outperform_notified_at  the once-only marker: when the worker's check
--                                    (social.metrics.check_outperforming) found the variant's 24-hour capture at 2x or
--                                    more of its channel's usual engagement and told the post's author and assignee. Set
--                                    with a conditional update (only while null), so two checks never both tell them;
--                                    never cleared. Null: not told (not checked yet, or not above the usual).
-- notification kind post_outperforming  in the app and by email, and a member can turn it off like the other kinds.
--
-- No new table, no new function: the check runs in the org's system context from the metrics sweep, right after the
-- capture it looks at is recorded, and reads only the org's own rows.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS outperform_notified_at timestamptz;

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below. The list is
-- the one of 20261029050000_crove_social_weekly_digest.sql with post_outperforming added.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%post_outperforming%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'', ''feed_paused'', ''mention'', ''publishing_hold'', ''queue_low'', ''weekly_digest'', ''post_outperforming'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;
