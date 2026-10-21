-- Crove Social: removing a published post from its platform (issue #860). Idempotent; applied files stay untouched.
--
-- crove_social.post_variant.status   gains 'removed': the platform confirmed that the published post is gone. The
--                                    variant stays 'published' while the remove call is on its way or unclear.
-- crove_social.post_variant.removed_at, removed_by, remove_reason, remove_requested_at
--                                    when the platform confirmed it, and the member who last asked, with their reason
--                                    and the time of the ask (social.variant.remove, owners and admins; the ask is
--                                    audited too).
-- post_variant_slot_uq               a removed variant frees its queue slot, as a published one does.
-- social-remove                      the worker's queue for the remove job (one job per ask).
SET LOCAL lock_timeout = '2s';

-- The new status. NOT VALID: added without scanning the table under its exclusive lock; validated below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_status_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%removed%'
  ) THEN
    ALTER TABLE crove_social.post_variant DROP CONSTRAINT IF EXISTS post_variant_status_check;
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_status_check CHECK (status IN (
      'draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'publishing', 'processing',
      'published', 'failed', 'ambiguous', 'needs_attention', 'paused', 'cancelled', 'removed')) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_status_check;

ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS removed_by uuid;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS remove_reason text;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS remove_requested_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_remove_reason') THEN
    -- NOT VALID: every existing row has no reason.
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_remove_reason CHECK (remove_reason IS NULL OR length(remove_reason) BETWEEN 1 AND 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_removed') THEN
    -- A removed variant has the time the platform confirmed it, and only a removed one has it. NOT VALID: no row is
    -- removed yet.
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_removed CHECK ((status = 'removed') = (removed_at IS NOT NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_remove_reason;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_removed;

-- The slot index skips removed variants too, so a removal never collides with a post queued in the slot since.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'crove_social' AND indexname = 'post_variant_slot_uq' AND indexdef LIKE '%removed%'
  ) THEN
    DROP INDEX IF EXISTS crove_social.post_variant_slot_uq;
    CREATE UNIQUE INDEX post_variant_slot_uq ON crove_social.post_variant (org_id, channel_connection_id, queue_slot_at)
      WHERE queue_slot_at IS NOT NULL AND status NOT IN ('cancelled', 'published', 'failed', 'removed');
  END IF;
END $$;

-- One job per ask (singleton key <org>:<variant>:remove:<last call seen>). create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('social-remove', '{"policy":"standard"}'::jsonb);
