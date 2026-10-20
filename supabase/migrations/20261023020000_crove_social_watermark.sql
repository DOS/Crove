-- The org's logo watermark for post images (issue #834). Idempotent; applied files stay untouched.
--
-- crove_social.watermark  the logo (an image of the org's Social library), the corner it goes in, its width as a share
--                         of the image's and its opacity. The composer draws it on a copy of an image in the browser
--                         and uploads the copy; nothing is drawn on the server. One per org, kept by the commands.
--                         Owners and admins edit; everyone reads.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.watermark (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  file_id uuid NOT NULL,
  corner text NOT NULL CHECK (corner IN ('top_left', 'top_right', 'bottom_left', 'bottom_right')),
  scale_percent smallint NOT NULL CHECK (scale_percent BETWEEN 5 AND 50),
  opacity_percent smallint NOT NULL CHECK (opacity_percent BETWEEN 10 AND 100),
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT watermark_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.watermark');
