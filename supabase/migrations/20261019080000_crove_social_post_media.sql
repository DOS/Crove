-- Images on Social posts (issue #372; Instagram and Zalo OA need them, Facebook posts photos). Idempotent; applied
-- files stay untouched.
--
-- crove_kernel.file.source 'social'   an image uploaded for a post. Stored, hashed and pinned to its object version
--                                      like every file (ADR-0013), but it is not an accounting document: it never goes
--                                      to extraction or the Inbox.
-- crove_social.post_media             the post's images, in order: the base media every variant inherits.
-- crove_social.post_variant.media     a variant's own media list (jsonb), NULL to inherit the post's. History
--                                      (published, cancelled) keeps the list it had here, as it keeps its text.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file DROP CONSTRAINT IF EXISTS file_source_check;
ALTER TABLE crove_kernel.file ADD CONSTRAINT file_source_check CHECK (source IN ('upload', 'email', 'social'));

CREATE TABLE IF NOT EXISTS crove_social.post_media (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  post_id uuid NOT NULL,
  file_id uuid NOT NULL,
  -- 1-based order in the post; channels take at most 35 items (TikTok photo posts), the commands cap it lower.
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 35),
  alt_text text CHECK (alt_text IS NULL OR length(alt_text) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT post_media_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE CASCADE,
  -- A file a post shows cannot be deleted from under it.
  CONSTRAINT post_media_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id),
  CONSTRAINT post_media_position_uq UNIQUE (org_id, post_id, position),
  CONSTRAINT post_media_file_uq UNIQUE (org_id, post_id, file_id)
);
CREATE INDEX IF NOT EXISTS post_media_file_idx ON crove_social.post_media (org_id, file_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.post_media');

-- [{ "fileId", "generation", "altText", "mime", "sizeBytes" }], at most 35 items; the commands write it.
ALTER TABLE crove_social.post_variant ADD COLUMN IF NOT EXISTS media jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post_variant'::regclass AND conname = 'post_variant_media_shape'
  ) THEN
    ALTER TABLE crove_social.post_variant ADD CONSTRAINT post_variant_media_shape
      CHECK (media IS NULL OR (jsonb_typeof(media) = 'array' AND jsonb_array_length(media) <= 35 AND octet_length(media::text) <= 65536));
  END IF;
END $$;
