-- Drafts from a blog's feed (issue #708). Idempotent; applied files stay untouched.
--
-- crove_social.feed            an RSS or Atom feed an org drafts posts from, for the channels it names. The worker reads
--                              it about every hour (through the egress guard, parsed in crove-extract). Five failed
--                              reads in a row pause it; owners and admins add, change, pause and remove feeds.
-- crove_social.feed_item       an item of a feed the worker has seen, by a hash of its guid (or link): once seen it is
--                              never drafted again. post_id is the draft made from it (none for the items already in
--                              the feed when it was added).
-- crove_social.feeds_due       the worker's scan, across orgs, of the feeds of active orgs due for a read. Ids only.
-- notification kind feed_paused  an owner or admin is told when a feed stops being read.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.feed (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  url text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 2000),
  -- The feed's own title, from its last read.
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 300),
  -- The channels its drafts are for; checked by the commands (the org's own connections).
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) BETWEEN 1 AND 20),
  paused boolean NOT NULL DEFAULT false,
  failures smallint NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 100),
  last_checked_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 64),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT feed_url_uq UNIQUE (org_id, url)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.feed');

CREATE TABLE IF NOT EXISTS crove_social.feed_item (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  feed_id uuid NOT NULL,
  -- sha256 of the item's key (guid, id, link or title), hex.
  item_key text NOT NULL CHECK (item_key ~ '^[0-9a-f]{64}$'),
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 300),
  post_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT feed_item_once UNIQUE (org_id, feed_id, item_key),
  CONSTRAINT feed_item_feed_fk FOREIGN KEY (org_id, feed_id) REFERENCES crove_social.feed (org_id, id) ON DELETE CASCADE,
  CONSTRAINT feed_item_post_fk FOREIGN KEY (org_id, post_id) REFERENCES crove_social.post (org_id, id) ON DELETE SET NULL (post_id)
);
CREATE INDEX IF NOT EXISTS feed_item_post_idx ON crove_social.feed_item (org_id, post_id) WHERE post_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_social.feed_item');
-- An item, once seen, stays as it was.
REVOKE UPDATE ON crove_social.feed_item FROM crove_tenant;

-- The new kind. NOT VALID: added without scanning the tables under their exclusive lock; validated below.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_mute'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.format('crove_social.%I', t)::regclass AND conname = t || '_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%feed_paused%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE crove_social.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_check');
      EXECUTE pg_catalog.format(
        'ALTER TABLE crove_social.%I ADD CONSTRAINT %I CHECK (kind IN (''review_requested'', ''decided'', ''failed'', ''needs_attention'', ''channel_expired'', ''comment'', ''client_answer'', ''assigned'', ''review_reminder'', ''feed_paused'')) NOT VALID',
        t, t || '_kind_check');
    END IF;
  END LOOP;
END $$;
ALTER TABLE crove_social.notification VALIDATE CONSTRAINT notification_kind_check;
ALTER TABLE crove_social.notification_mute VALIDATE CONSTRAINT notification_mute_kind_check;

-- Feeds of active orgs, not paused, never read or read over 55 minutes ago; the longest wait first.
CREATE OR REPLACE FUNCTION crove_social.feeds_due(p_limit int)
RETURNS TABLE (org_id uuid, feed_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT f.org_id, f.id
  FROM crove_social.feed f
  JOIN crove_kernel.tenant t ON t.org_id = f.org_id AND t.status = 'active'
  WHERE NOT f.paused AND (f.last_checked_at IS NULL OR f.last_checked_at < pg_catalog.now() - interval '55 minutes')
  ORDER BY f.last_checked_at NULLS FIRST, f.org_id, f.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.feeds_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.feeds_due(int) TO crove_worker;
