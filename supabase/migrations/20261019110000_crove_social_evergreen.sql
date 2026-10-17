-- Evergreen posts and reposts (Social plan S9, issue #393). Idempotent; applied files stay untouched.
--
-- crove_social.post.evergreen_days   a published post marked evergreen is drafted again every N days (7 to 365) and
--                                    sent to review; a person approves each repost, as for any post.
-- crove_social.post.repost_of        the post a repost copies (a manual repost or an evergreen one).
-- crove_social.evergreen_due         the worker's scan, across orgs, of evergreen posts due for a repost: published,
--                                    the last publish (or repost) N days ago, and no repost of it still open. Ids only.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS evergreen_days smallint;
ALTER TABLE crove_social.post ADD COLUMN IF NOT EXISTS repost_of uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_evergreen_days_range') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_evergreen_days_range CHECK (evergreen_days IS NULL OR evergreen_days BETWEEN 7 AND 365);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_social.post'::regclass AND conname = 'post_repost_of_fk') THEN
    ALTER TABLE crove_social.post ADD CONSTRAINT post_repost_of_fk FOREIGN KEY (org_id, repost_of) REFERENCES crove_social.post (org_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS post_repost_of_idx ON crove_social.post (org_id, repost_of) WHERE repost_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_evergreen_idx ON crove_social.post (org_id) WHERE evergreen_days IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_social.evergreen_due(p_limit int)
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_social.post p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  CROSS JOIN LATERAL (
    SELECT max(v.published_at) AS at FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published'
  ) pub
  CROSS JOIN LATERAL (
    SELECT max(r.created_at) AS at FROM crove_social.post r WHERE r.org_id = p.org_id AND r.repost_of = p.id
  ) rep
  WHERE p.evergreen_days IS NOT NULL
    AND p.status IN ('published', 'partially_published')
    AND pub.at IS NOT NULL
    AND GREATEST(pub.at, coalesce(rep.at, pub.at)) < pg_catalog.now() - pg_catalog.make_interval(days => p.evergreen_days)
    -- A repost still on its way (draft, in review, scheduled, publishing) waits for a person; no second one meanwhile.
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post r
      WHERE r.org_id = p.org_id AND r.repost_of = p.id AND r.status NOT IN ('published', 'partially_published', 'failed', 'cancelled')
    )
  ORDER BY pub.at
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.evergreen_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.evergreen_due(int) TO crove_worker;
