-- Crove Social: banned and sensitive words, warned or blocked before approval (issue #1055). Idempotent; applied files
-- stay untouched.
--
-- crove_social.banned_word  a word or phrase the org does not want in its posts. level 'warn' shows it to the writer and
--                           the reviewer; 'block' also refuses social.post.submit, the approval in social.variant.decide
--                           and social.variant.schedule (422 BANNED_WORDS), and keeps evergreen and recurring copies
--                           with it as drafts. phrase is as the owner or admin typed it (NFC); normalized is the phrase
--                           the matcher compares (NFC, format characters dropped, spaces collapsed, lower case), one per
--                           org. reason is shown with the match. connection_ids: the channels it applies to, every
--                           channel when empty. Owners and admins add and remove words (the commands check the role);
--                           every member reads them, for the composer. A word is never edited: it is removed and added
--                           again. Crove ships no list of its own.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.banned_word (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  phrase text NOT NULL CHECK (length(phrase) BETWEEN 1 AND 100),
  normalized text NOT NULL CHECK (length(normalized) BETWEEN 1 AND 200),
  level text NOT NULL CHECK (level IN ('warn', 'block')),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) <= 50),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
-- One entry per phrase as the matcher compares it.
CREATE UNIQUE INDEX IF NOT EXISTS banned_word_normalized_uq ON crove_social.banned_word (org_id, normalized);
SELECT crove_kernel.apply_tenant_rls('crove_social.banned_word');
-- A word is added and removed, never changed.
REVOKE UPDATE ON crove_social.banned_word FROM crove_tenant;
