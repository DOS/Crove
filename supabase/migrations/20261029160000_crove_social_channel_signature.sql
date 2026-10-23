-- A default signature per channel (issue #1190). Idempotent; applied files stay untouched.
--
-- crove_social.channel_policy.signature  the block a channel's new posts end with (hotline, address, shop link, brand
--                                        hashtags): plain text of 1 to 500 characters, or null for none. A channel
--                                        added to a post copies it into the variant's settings (settings.signature),
--                                        so changing it later never alters a post already written or approved. No
--                                        new grant: owners and admins write it through social.channel.set_signature,
--                                        as the channel's other policy settings.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.channel_policy ADD COLUMN IF NOT EXISTS signature text
  CONSTRAINT channel_policy_signature_length CHECK (signature IS NULL OR pg_catalog.char_length(signature) BETWEEN 1 AND 500);
