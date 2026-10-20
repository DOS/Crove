-- A saved brand voice for AI drafts (issue #741). Idempotent; applied files stay untouched.
--
-- crove_social.brand_voice  how the org's posts should sound, or one channel's: a short description, words to use and
--                           to avoid, and whether to use emoji. AI drafts and rewrites use the channel's voice, else
--                           the org's (channel_connection_id NULL), unless the member gives a tone for that request.
--                           One per org and channel, kept by the commands. Owners and admins edit; everyone reads.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.brand_voice (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- NULL: the org's voice.
  channel_connection_id uuid,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 600),
  use_words text[] NOT NULL DEFAULT '{}' CHECK (cardinality(use_words) <= 20),
  avoid_words text[] NOT NULL DEFAULT '{}' CHECK (cardinality(avoid_words) <= 20),
  emoji boolean NOT NULL DEFAULT true,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT brand_voice_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS brand_voice_connection_idx ON crove_social.brand_voice (org_id, channel_connection_id);
SELECT crove_kernel.apply_tenant_rls('crove_social.brand_voice');
