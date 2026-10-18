-- Social evergreen (#402 item 1): the worker's scan took the 50 oldest due posts. A post whose repost fails every time
-- (rolled back, so it stays due) came first every hour, and 50 such posts kept every other evergreen post from being
-- reached. The due posts are now taken in an order that changes every hour (a hash of the post and the hour), so each
-- due post comes within the limit in some hour, whatever the others do. Only the order changes.
SET LOCAL lock_timeout = '2s';

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
  -- The same order within an hour (two runs agree), another one the next hour.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.now()), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.evergreen_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.evergreen_due(int) TO crove_worker;
