-- Correcting a published post's text on its platform (issue #1223). Idempotent; applied files stay untouched.
--
-- crove_social.post_variant.edit_body, edit_content_hash, edit_requested_at, edit_requested_by, edit_state
--                                    the edit an owner or admin asked for (social.variant.edit_published, audited): the
--                                    variant's new own text, the hash of its content with it (which their approval,
--                                    a post_approval row of the next revision, binds), when and who, and where it
--                                    stands: pending until the platform answers, failed when it refused, unknown when
--                                    its answer was unclear. All five are set together or not at all. The variant's
--                                    body, revision and content_hash change only on the platform's confirmation,
--                                    which clears them; a failed or unclear edit stays for the post page to show until
--                                    the next ask.
-- crove_social.post_variant.published_revision
--                                    the revision the variant went out under, kept at its first confirmed edit, when
--                                    its revision moves on: the external_call keys of its publish and of every step
--                                    after it (first comment, thread, pin, gate, playlists, auto-reply, repost,
--                                    removal, edits) stay named by it, so nothing done once for the post runs again.
--                                    Null for a variant never edited after publishing: its revision is that one.
-- social-edit                        the worker's queue for the edit job (one job per ask).
--
-- No new grant: crove_tenant updates post_variant as a whole table (20261019000000), and the commands decide who may.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS edit_body text;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS edit_content_hash text;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS edit_requested_at timestamptz;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS edit_requested_by uuid;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS edit_state text;
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS published_revision integer;

-- NOT VALID: added without scanning the table under its exclusive lock; validated below (every existing row has all
-- six NULL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_edit_body') THEN
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_edit_body CHECK (edit_body IS NULL OR pg_catalog.length(edit_body) <= 100000) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_edit_content_hash') THEN
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_edit_content_hash CHECK (edit_content_hash IS NULL OR edit_content_hash ~ '^sha256:[0-9a-f]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_edit_state_check') THEN
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_edit_state_check CHECK (edit_state IN ('pending', 'failed', 'unknown')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_edit_together') THEN
    -- An edit is the five together: its text, hash, time, person and state, or none of them.
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_edit_together CHECK (
      (edit_state IS NULL) = (edit_body IS NULL)
      AND (edit_state IS NULL) = (edit_content_hash IS NULL)
      AND (edit_state IS NULL) = (edit_requested_at IS NULL)
      AND (edit_state IS NULL) = (edit_requested_by IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_published_revision') THEN
    -- Kept only once the revision moved past it.
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_published_revision CHECK (published_revision IS NULL OR (published_revision >= 1 AND published_revision < revision)) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_edit_body;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_edit_content_hash;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_edit_state_check;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_edit_together;
ALTER TABLE crove_social.post_variant VALIDATE CONSTRAINT post_variant_published_revision;

-- One job per ask (singleton key <org>:<variant>:edit:<last call seen>). create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('social-edit', '{"policy":"standard"}'::jsonb);
