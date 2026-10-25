-- Crove Social: a TikTok account's creator options in a channel's options for the composer (issue #1497). Idempotent;
-- applied files stay untouched.
--
-- crove_social.channel_option.kind  widened with tiktok_creator (what TikTok's creator_info answers for the account:
--                              the privacy levels it may post with, the interactions the creator turned off, the
--                              longest video it may post and its nickname, each as one { id, name } item). The rows,
--                              their guards (channel_option_before_update, channel_option_before_insert), row-level
--                              security, grants, the queue and the org purge are those of
--                              20261029060000_crove_social_channel_option.sql and do not change: only the worker
--                              records a list, and publishing never trusts it (the adapter reads creator_info again).
SET LOCAL lock_timeout = '2s';

-- NOT VALID: added without scanning the table under its exclusive lock; validated below. The list is the one of
-- 20261029070000_crove_social_channel_option_kinds.sql with the kind added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.channel_option'::regclass AND conname = 'channel_option_kind_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%tiktok_creator%'
  ) THEN
    ALTER TABLE crove_social.channel_option DROP CONSTRAINT IF EXISTS channel_option_kind_check;
    ALTER TABLE crove_social.channel_option ADD CONSTRAINT channel_option_kind_check
      CHECK (kind IN ('pinterest_section', 'youtube_playlist', 'wordpress_term', 'tiktok_creator')) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.channel_option VALIDATE CONSTRAINT channel_option_kind_check;
