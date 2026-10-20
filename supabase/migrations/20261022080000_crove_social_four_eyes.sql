-- Four-eyes approval on a channel (issue #740). Idempotent; applied files stay untouched.
--
-- crove_social.channel_policy.four_eyes  when on, the author of a post may not approve it on this channel: someone
--                                         else must (changes requested and rejections stay theirs to make). Off by
--                                         default, as today. Owners turn it on and off (turning it off weakens review).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.channel_policy ADD COLUMN IF NOT EXISTS four_eyes boolean NOT NULL DEFAULT false;
