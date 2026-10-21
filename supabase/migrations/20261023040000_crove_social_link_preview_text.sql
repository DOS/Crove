-- A link's page text for AI drafts (issue #779). Idempotent; applied files stay untouched.
--
-- crove_social.link_preview.text  the page's main text as crove-extract read it (the article, else the main part, else
--                                 the body, without menus or footers), at most 4000 characters; null for a page that
--                                 had none and for answers read before. Written by the worker with the rest of the
--                                 answer; only AI drafts read it, as tainted data.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.link_preview ADD COLUMN IF NOT EXISTS text text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.link_preview'::regclass AND conname = 'link_preview_text') THEN
    -- NOT VALID: added without scanning the table under its exclusive lock; every existing row has no text.
    ALTER TABLE crove_social.link_preview ADD CONSTRAINT link_preview_text CHECK (text IS NULL OR length(text) BETWEEN 1 AND 4000) NOT VALID;
  END IF;
END $$;
ALTER TABLE crove_social.link_preview VALIDATE CONSTRAINT link_preview_text;
GRANT UPDATE (text) ON crove_social.link_preview TO crove_tenant;
