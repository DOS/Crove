-- Crove Social: white-label client reports, with the agency's logo and colour (issue #1053). Idempotent; applied files
-- stay untouched.
--
-- crove_social.report_branding  an org's branding of its client report and review pages, the plan print and the report
--                               mail: display_name (empty: the org's own name), logo (a small inline data URL the
--                               browser made from an image of the Social library: PNG, WebP or JPEG, at most 64 KB
--                               decoded, never SVG, whose markup can carry script; the CHECK reads the declared type
--                               and the file's magic number), accent (one colour, #rrggbb; the command refuses one with
--                               less than 3:1 contrast against the page) and hide_crove (no "Crove" on the pages or in
--                               the mail). One per org, kept by the commands under an advisory lock, as the watermark
--                               is. Owners and admins save and remove it (the commands check the role); every member
--                               reads it.
-- crove_social.report_brand(org)  the brand as the public views return it: { name, logo, accent, hideCrove }, or null
--                               when the org has none. Called only by the definers below (no grant).
--
-- crove_social.report_link_view(token)  as in 20261026053000, with the same signature, RETURNS, checks (token format
--                               and hash, revoked, expiry, active org) and grants, plus brand: the link's own org's.
-- crove_social.review_link_view(token)  as in 20261023233000, the same, plus brand on a single-post and a plan page.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.report_branding (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  display_name text CHECK (display_name IS NULL OR (length(display_name) BETWEEN 1 AND 100 AND display_name !~ '[[:cntrl:]]')),
  -- The prefix and the canonical base64 of at most 65536 bytes (87407 characters with the longest prefix); the first
  -- 12 bytes (16 base64 characters) hold the magic number of the declared type. The CASE keeps decode() to a value the
  -- pattern already accepted.
  logo text CONSTRAINT report_branding_logo_check CHECK (
    logo IS NULL OR CASE
      WHEN length(logo) > 87407 THEN false
      WHEN logo !~ '^data:image/(png|webp|jpeg);base64,([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN false
      WHEN logo LIKE 'data:image/png;base64,%' THEN
        pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 23, 16), 'base64'), 1, 8) = '\x89504e470d0a1a0a'::bytea
      WHEN logo LIKE 'data:image/jpeg;base64,%' THEN
        pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 24, 16), 'base64'), 1, 3) = '\xffd8ff'::bytea
      ELSE
        pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 24, 16), 'base64'), 1, 4) = '\x52494646'::bytea
        AND pg_catalog.substr(pg_catalog.decode(pg_catalog.substr(logo, 24, 16), 'base64'), 9, 4) = '\x57454250'::bytea
    END
  ),
  accent text CHECK (accent IS NULL OR accent ~ '^#[0-9a-f]{6}$'),
  hide_crove boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_social.report_branding');

CREATE OR REPLACE FUNCTION crove_social.report_brand(p_org uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object('name', b.display_name, 'logo', b.logo, 'accent', b.accent, 'hideCrove', b.hide_crove)
  FROM crove_social.report_branding b
  WHERE b.org_id = p_org
  ORDER BY b.created_at, b.id
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION crove_social.report_brand(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Same body as 20261026053000, plus brand.
CREATE OR REPLACE FUNCTION crove_social.report_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.report_link;
  v_prev_start timestamptz;
BEGIN
  -- 32 random bytes, base64url without padding (newReportToken in modules/social).
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.* INTO v_link FROM crove_social.report_link l
  WHERE l.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  IF v_link.id IS NULL OR v_link.revoked_at IS NOT NULL OR v_link.expires_at <= pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id AND t.status = 'active') THEN
    RETURN NULL;
  END IF;
  -- The period of the same length just before the link's, by its exact length in seconds: an interval with days in
  -- it would be taken in the session's time zone, so daylight saving could shift the start.
  v_prev_start := v_link.period_start - pg_catalog.make_interval(secs => EXTRACT(epoch FROM v_link.period_end - v_link.period_start)::double precision);
  RETURN (
    WITH p AS (
      SELECT true AS cur, v_link.period_start AS ps, v_link.period_end AS pe
      UNION ALL
      SELECT false, v_prev_start, v_link.period_start
    ),
    v AS (
      -- What went out in each period on the link's channels, with the latest real counts of each.
      SELECT p.cur, p.ps, p.pe, x.*
      FROM p CROSS JOIN LATERAL (
        SELECT v.id, v.provider, v.channel_connection_id AS conn, coalesce(v.body, p2.body) AS body, v.published_at, v.external_url,
               coalesce(s.metrics, '{}'::jsonb) AS metrics
        FROM crove_social.post_variant v
        JOIN crove_social.post p2 ON p2.org_id = v.org_id AND p2.id = v.post_id
        LEFT JOIN LATERAL (
          SELECT m.metrics FROM crove_social.metric_snapshot m
          WHERE m.org_id = v.org_id AND m.variant_id = v.id
          ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
        ) s ON true
        WHERE v.org_id = v_link.org_id AND v.status = 'published'
          AND v.published_at >= p.ps AND v.published_at < p.pe
          AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR v.channel_connection_id = ANY (v_link.connection_ids))
        ORDER BY v.published_at DESC
        LIMIT 5000
      ) x
    ),
    n AS (
      -- The counts Crove knows (METRIC_NAMES of packages/channel), as numbers; anything else a snapshot holds is left out.
      SELECT v.cur, v.id, v.conn, e.key, (e.value #>> '{}')::numeric AS value
      FROM v, pg_catalog.jsonb_each(v.metrics) e
      WHERE pg_catalog.jsonb_typeof(e.value) = 'number'
        AND e.key IN ('impressions', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'views')
      UNION ALL
      -- The clicks on Crove's short links (#706) of what went out, every revision of it, on the days (UTC) whose midday is
      -- in its period (clicks are kept by UTC day; a period is in the org's own zone). Not part of a post's score: a
      -- channel's own clicks may count the same people. A post that went out with a link nobody clicked shows 0.
      SELECT v.cur, v.id, v.conn, 'linkClicks', coalesce(pg_catalog.sum(k.clicks), 0)::numeric
      FROM v
      JOIN crove_social.short_link l ON l.org_id = v_link.org_id AND l.variant_id = v.id
      LEFT JOIN crove_social.short_link_click k ON k.org_id = l.org_id AND k.short_link_id = l.id
        AND (k.day + time '12:00') AT TIME ZONE 'UTC' >= v.ps
        AND (k.day + time '12:00') AT TIME ZONE 'UTC' < v.pe
      GROUP BY v.cur, v.id, v.conn
    ),
    score AS (
      SELECT v.id, coalesce(pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('reactions', 'comments', 'shares', 'saves', 'clicks')), 0) AS engagement,
             coalesce(pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('views', 'impressions', 'reach')), 0) AS seen
      FROM v LEFT JOIN n ON n.cur AND n.id = v.id
      WHERE v.cur
      GROUP BY v.id
    ),
    per_channel AS (
      -- Every channel with posts in either period, so the channels add up to both periods' totals.
      SELECT v.conn, pg_catalog.count(*) FILTER (WHERE v.cur) AS posts, pg_catalog.count(*) FILTER (WHERE NOT v.cur) AS prev_posts FROM v GROUP BY v.conn
    )
    SELECT pg_catalog.jsonb_build_object(
      'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
      -- The white-label branding of the link's own org (#1053), or null.
      'brand', crove_social.report_brand(v_link.org_id),
      'title', v_link.title,
      'periodStart', v_link.period_start,
      'periodEnd', v_link.period_end,
      'expiresAt', v_link.expires_at,
      'posts', (SELECT pg_catalog.count(*) FROM v WHERE v.cur),
      'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE n.cur GROUP BY n.key) t), '{}'::jsonb),
      'previous', pg_catalog.jsonb_build_object(
        'periodStart', v_prev_start,
        'periodEnd', v_link.period_start,
        'posts', (SELECT pg_catalog.count(*) FROM v WHERE NOT v.cur),
        'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE NOT n.cur GROUP BY n.key) t), '{}'::jsonb)
      ),
      'channels', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', c.provider,
          'posts', pc.posts,
          'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE n.cur AND n.conn = pc.conn GROUP BY n.key) t), '{}'::jsonb),
          'previous', pg_catalog.jsonb_build_object(
            'posts', pc.prev_posts,
            'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE NOT n.cur AND n.conn = pc.conn GROUP BY n.key) t), '{}'::jsonb)
          )
        ) ORDER BY pc.posts DESC, pc.prev_posts DESC, c.display_name)
        FROM per_channel pc
        JOIN crove_kernel.channel_connection c ON c.org_id = v_link.org_id AND c.id = pc.conn
      ), '[]'::jsonb),
      'top', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', v.provider,
          'excerpt', pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v.body, '\s+', ' ', 'g')), 200),
          'publishedAt', v.published_at,
          'url', CASE WHEN v.external_url ~ '^https://' THEN v.external_url END,
          'metrics', coalesce((SELECT pg_catalog.jsonb_object_agg(n.key, n.value) FROM n WHERE n.cur AND n.id = v.id), '{}'::jsonb)
        ) ORDER BY s.engagement DESC, s.seen DESC, v.published_at DESC)
        FROM (SELECT * FROM score ORDER BY engagement DESC, seen DESC LIMIT 10) s
        JOIN v ON v.cur AND v.id = s.id
        JOIN crove_kernel.channel_connection c ON c.org_id = v_link.org_id AND c.id = v.conn
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.report_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.report_link_view(text) TO crove_app;

-- Same body as 20261023233000, plus brand on both kinds of page.
CREATE OR REPLACE FUNCTION crove_social.review_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.review_link;
  v_post crove_social.post;
BEGIN
  v_link := crove_social.review_link_by_token(p_token, false);
  IF v_link.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_link.kind = 'plan' THEN
    -- The plan page, with the white-label branding of the link's own org (#1053), or null.
    RETURN crove_social.review_plan_page(v_link) || pg_catalog.jsonb_build_object('brand', crove_social.report_brand(v_link.org_id));
  END IF;
  SELECT p.* INTO v_post FROM crove_social.post p WHERE p.org_id = v_link.org_id AND p.id = v_link.post_id;
  RETURN pg_catalog.jsonb_build_object(
    'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
    -- The white-label branding of the link's own org (#1053), or null.
    'brand', crove_social.report_brand(v_link.org_id),
    'expiresAt', v_link.expires_at,
    'changed', crove_social.review_content_key(v_link.org_id, v_link.post_id) <> v_link.content_key,
    'channels', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', v.provider,
        'channel', c.display_name,
        'status', v.status,
        'body', CASE WHEN v.content_frozen THEN coalesce(v.body, '') ELSE coalesce(v.body, v_post.body) END,
        'title', CASE WHEN v.content_frozen THEN v.title ELSE coalesce(v.title, v_post.title) END,
        'linkUrl', CASE WHEN v.content_frozen THEN v.link_url ELSE coalesce(v.link_url, v_post.link_url) END,
        'mediaCount', CASE WHEN pg_catalog.jsonb_typeof(v.media) = 'array' THEN pg_catalog.jsonb_array_length(v.media)
          ELSE (SELECT pg_catalog.count(*)::int FROM crove_social.post_media m WHERE m.org_id = v.org_id AND m.post_id = v.post_id) END
      ) ORDER BY v.position, v.id)
      FROM crove_social.post_variant v
      JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id
      WHERE v.org_id = v_link.org_id AND v.post_id = v_link.post_id AND v.status <> 'cancelled'
    ), '[]'::jsonb),
    'feedback', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.reviewer_name, 'verdict', f.verdict, 'body', f.body, 'at', f.created_at) ORDER BY f.created_at DESC)
      FROM (SELECT * FROM crove_social.review_feedback f0 WHERE f0.org_id = v_link.org_id AND f0.link_id = v_link.id ORDER BY f0.created_at DESC LIMIT 50) f
    ), '[]'::jsonb)
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.review_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.review_link_view(text) TO crove_app;
