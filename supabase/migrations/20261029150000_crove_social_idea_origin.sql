-- AI post ideas (#1181): an idea on the ideas board (#701) may come from an AI suggestion the member kept. Idempotent.
--
-- origin  'human' for an idea a person wrote (every idea before this one), 'ai' for one the member kept from the AI's
--         suggestions. Set when the idea is created and never changed: social.idea.create takes it, and the column
--         is left out of crove_tenant's UPDATE grant below, so no command can clear the mark. A draft made from an AI
--         idea is tainted (social.post.create with ideaId) and needs a person's approval like any AI text.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.idea ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'human';

-- NOT VALID: added without scanning the table under its exclusive lock; validated below (every existing row has the
-- default).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.idea'::regclass AND conname = 'idea_origin_check') THEN
    ALTER TABLE crove_social.idea ADD CONSTRAINT idea_origin_check CHECK (origin IN ('human', 'ai')) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.idea VALIDATE CONSTRAINT idea_origin_check;

-- The columns the idea commands write (social.idea.update and .move, and linkIdeaToPost): everything but the org, the
-- id, who made it and when, and now its origin. Until now crove_tenant had UPDATE on the whole table, which would have
-- covered the new column.
REVOKE UPDATE ON crove_social.idea FROM crove_tenant;
GRANT UPDATE (title, note, link_url, file_ids, stage, post_id, updated_at) ON crove_social.idea TO crove_tenant;
