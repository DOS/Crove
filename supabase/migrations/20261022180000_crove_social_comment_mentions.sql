-- @mentions in internal post comments (#793): a member mentioned in a comment gets a notification of kind mention
-- (in the app, and by email unless they turned Social emails off). The comment keeps the mention as <@user-id>.
SET LOCAL lock_timeout = '2s';

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%mention%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'', ''feed_paused'', ''mention'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;