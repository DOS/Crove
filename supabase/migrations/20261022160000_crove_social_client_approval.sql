-- The client's approval as a review step (issue #770, research §5.2: a client stage). Idempotent; applied files stay
-- untouched.
--
-- crove_social.channel_policy.client_approval  on a channel with it, a variant whose team approvals are all in still
--                                              waits for the client's "Approved" on a review link of the post, given
--                                              for the content as it is now; the client's "Needs changes" sends it
--                                              back. Off by default: review links stay comments for the team.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.channel_policy ADD COLUMN IF NOT EXISTS client_approval boolean NOT NULL DEFAULT false;
