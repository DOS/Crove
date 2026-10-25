-- TikTok posts that get their public id later (#1475).
-- crove_social.late_id_due  the worker's scan, across orgs, of the published TikTok variants still waiting for their
--                           public id (known by a publish_id, no note) or for their inbox draft to be posted (no post
--                           id, the SENT_TO_APP note), on active channels of active orgs, within 8 days of their
--                           publish (7 days of asking and a day of grace to record the end), whose next check
--                           (next_check_at, unused on a published variant before) has come. A direct post that is not
--                           PUBLIC_TO_EVERYONE never gets a public id and is left out (SELF_ONLY included). Ids only,
--                           for crove_worker alone. No table or column changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_social.late_id_due(p_limit int)
RETURNS TABLE (org_id uuid, variant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.org_id, v.id
  FROM crove_social.post_variant v
  JOIN crove_kernel.tenant t ON t.org_id = v.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id AND c.status = 'active'
  WHERE v.provider = 'tiktok'
    AND v.status = 'published'
    AND v.published_at > pg_catalog.now() - interval '8 days'
    AND (v.next_check_at IS NULL OR v.next_check_at <= pg_catalog.now())
    AND (
      (coalesce(v.settings ->> 'tiktokMode', 'direct') = 'inbox' AND v.external_post_id IS NULL AND v.error_code = 'SENT_TO_APP')
      OR (v.external_post_id IS NOT NULL AND v.external_post_id !~ '^[0-9]{1,32}$' AND v.error_code IS NULL
        AND (coalesce(v.settings ->> 'tiktokMode', 'direct') = 'inbox'
          OR (coalesce(v.settings ->> 'tiktokMode', 'direct') = 'direct' AND v.settings ->> 'privacyLevel' = 'PUBLIC_TO_EVERYONE')))
    )
  ORDER BY v.next_check_at NULLS FIRST, v.published_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION crove_social.late_id_due(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.late_id_due(int) TO crove_worker;
