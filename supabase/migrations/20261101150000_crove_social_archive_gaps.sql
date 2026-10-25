-- Crove Social: archived posts (#1299) stay out of the public feeds and the repeat scans (issue #1361, closing #1327,
-- #1331 and #1341). Idempotent; applied files stay untouched. No column, no table: four definers re-created from their
-- newest definitions with the archived filter added, each with the same signature, RETURNS, SECURITY DEFINER,
-- search_path and EXECUTE grants.
--
-- crove_social.calendar_feed_events  the subscribed calendar (#862) leaves out the channel posts of an archived post,
--                                    as the in-app calendar does; they come back on restore. Archived posts cannot be
--                                    scheduled, so only published ones were shown.
-- crove_social.bio_page_posts        the link-in-bio page (#707) leaves out archived posts, and so bio_page_view,
--                                    bio_page_go and bio_page_file, which read through it, no longer show, open or
--                                    serve them.
-- crove_social.evergreen_due         an archived repost counts as done for its source: archived before evergreen was
-- crove_social.recurring_due         turned back on, it no longer holds the next repost or copy back for good (the
--                                    command checks again under the source's lock, with the same rule). An archived
--                                    source is never listed (archiving turns its repeats off; this keeps it so).
SET LOCAL lock_timeout = '2s';

-- The calendar feed of 20261023080000_crove_social_calendar_feed.sql, with archived posts left out.
CREATE OR REPLACE FUNCTION crove_social.calendar_feed_events(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_feed crove_social.calendar_feed;
  v_tenant crove_kernel.tenant;
BEGIN
  -- 32 random bytes, base64url without padding (newReportToken in modules/social).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT f.* INTO v_feed FROM crove_social.calendar_feed f
  WHERE f.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_feed.id IS NULL OR v_feed.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.* INTO v_tenant FROM crove_kernel.tenant t WHERE t.org_id = v_feed.org_id AND t.status = 'active';
  IF v_tenant.org_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    WITH v AS (
      -- Scheduled (at a time or in a queue slot) and published channel posts, with their effective title and text:
      -- history (content_frozen) keeps its own, NULL then meaning none. Not of an archived post (#1299).
      SELECT v.id, v.post_id, v.provider, v.status,
             CASE WHEN v.status = 'published' THEN coalesce(v.published_at, v.queue_slot_at, v.scheduled_at) ELSE coalesce(v.queue_slot_at, v.scheduled_at) END AS at,
             CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, p.title) END AS title,
             CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, p.body) END AS body
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      WHERE v.org_id = v_feed.org_id AND v.status IN ('scheduled', 'published') AND p.archived_at IS NULL
    ),
    e AS (
      SELECT v.id, v.post_id, v.provider, v.status, v.at,
             -- The title, else the text's first line, on one line and at most 100 characters.
             pg_catalog.btrim(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(
               nullif(pg_catalog.btrim(v.title), ''),
               pg_catalog.split_part(pg_catalog.btrim(v.body, E' \t\r\n'), E'\n', 1)
             ), '\s+', ' ', 'g')), 100)) AS title
      FROM v
      WHERE v.at >= pg_catalog.now() - interval '30 days' AND v.at < pg_catalog.now() + interval '60 days'
      -- Past 1000, the ones nearest to now stay (the week at hand matters more than a month ago or two months on).
      ORDER BY pg_catalog.abs(EXTRACT(EPOCH FROM v.at - pg_catalog.now())), v.id
      LIMIT 1000
    )
    SELECT pg_catalog.jsonb_build_object(
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'events', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', e.id,
          'postId', e.post_id,
          'provider', e.provider,
          'at', e.at,
          'status', e.status,
          'title', e.title
        ) ORDER BY e.at, e.id)
        FROM e
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.calendar_feed_events(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.calendar_feed_events(text) TO crove_app;

-- The posts a page shows, of 20261022055000_crove_social_bio_page.sql, with archived posts left out.
CREATE OR REPLACE FUNCTION crove_social.bio_page_posts(p_org uuid)
RETURNS TABLE (post_id uuid, file_id uuid, excerpt text, link text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.id, m.file_id, left(regexp_replace(coalesce(nullif(p.title, ''), p.body), '\s+', ' ', 'g'), 140),
         coalesce(
           CASE WHEN p.link_url ~ '^https?://' THEN p.link_url END,
           (SELECT v.external_url FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published' AND v.external_url ~ '^https?://' ORDER BY v.published_at DESC LIMIT 1)
         )
  FROM crove_social.post p
  JOIN LATERAL (
    SELECT pm.file_id FROM crove_social.post_media pm JOIN crove_kernel.file f ON f.org_id = pm.org_id AND f.id = pm.file_id
    WHERE pm.org_id = p.org_id AND pm.post_id = p.id AND f.content_type IN ('image/jpeg', 'image/png', 'image/webp')
    ORDER BY pm.position LIMIT 1
  ) m ON true
  WHERE p.org_id = p_org
    AND p.archived_at IS NULL
    AND EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published')
  ORDER BY (SELECT max(v.published_at) FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'published') DESC NULLS LAST, p.id
  LIMIT 12
$$;
REVOKE ALL ON FUNCTION crove_social.bio_page_posts(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The evergreen scan of 20261029234000_crove_social_text_variations.sql, with an archived repost counted as done and
-- an archived source left out.
CREATE OR REPLACE FUNCTION crove_social.evergreen_due(p_limit int, p_skip uuid[])
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
    AND p.archived_at IS NULL
    AND p.status IN ('published', 'partially_published')
    AND pub.at IS NOT NULL
    AND GREATEST(pub.at, coalesce(rep.at, pub.at)) < pg_catalog.now() - pg_catalog.make_interval(days => p.evergreen_days)
    -- A repost still on its way (draft, in review, scheduled, publishing) waits for a person; no second one meanwhile.
    -- An archived one (#1299) waits for nobody: it is done.
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post r
      WHERE r.org_id = p.org_id AND r.repost_of = p.id AND r.archived_at IS NULL AND r.status NOT IN ('published', 'partially_published', 'failed', 'cancelled')
    )
    AND NOT EXISTS (SELECT 1 FROM crove_social.publish_hold h WHERE h.org_id = p.org_id AND h.released_at IS NULL)
    AND p.id <> ALL (coalesce(p_skip, '{}'::uuid[]))
  -- The same order within an hour of UTC (two runs agree, whatever their session time zone), another one the next.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.timezone('UTC', pg_catalog.now())), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.evergreen_due(int, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.evergreen_due(int, uuid[]) TO crove_worker;

-- The recurring scan of 20261029234000_crove_social_text_variations.sql, with an archived copy counted as done and an
-- archived source left out. The horizon (7 days) is RECURRING_HORIZON_MS in modules/social/src/recurring.ts.
CREATE OR REPLACE FUNCTION crove_social.recurring_due(p_limit int, p_skip uuid[])
RETURNS TABLE (org_id uuid, post_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.org_id, p.id
  FROM crove_social.post p
  JOIN crove_kernel.tenant t ON t.org_id = p.org_id AND t.status = 'active'
  WHERE p.recurrence IS NOT NULL
    AND p.archived_at IS NULL
    AND (p.recurrence_next_at IS NULL OR p.recurrence_next_at <= pg_catalog.now() + pg_catalog.make_interval(days => 7))
    -- The series starts once the post went out on a channel: a copy repeats what went out. One taken down since on
    -- every channel is listed too, for the command to end.
    AND EXISTS (
      SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status IN ('published', 'removed')
    )
    -- A copy still on its way (in review, scheduled, publishing, rejected, needing a person) holds the next one back.
    -- An archived one (#1299) waits for nobody: it is done.
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.post c
      JOIN crove_social.post_variant cv ON cv.org_id = c.org_id AND cv.post_id = c.id
      WHERE c.org_id = p.org_id AND c.recurrence_source_id = p.id AND c.archived_at IS NULL AND cv.status NOT IN ('published', 'failed', 'cancelled', 'removed')
    )
    AND NOT EXISTS (SELECT 1 FROM crove_social.publish_hold h WHERE h.org_id = p.org_id AND h.released_at IS NULL)
    AND p.id <> ALL (coalesce(p_skip, '{}'::uuid[]))
  -- The same order within an hour of UTC (as evergreen_due, #402): a post whose copy fails every time cannot keep the
  -- others out of the limit.
  ORDER BY pg_catalog.md5(p.id::text || pg_catalog.to_char(pg_catalog.date_trunc('hour', pg_catalog.timezone('UTC', pg_catalog.now())), 'YYYYMMDDHH24')), p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

REVOKE ALL ON FUNCTION crove_social.recurring_due(int, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.recurring_due(int, uuid[]) TO crove_worker;
