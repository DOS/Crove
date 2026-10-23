-- A client report for one campaign label, with a per-link audience choice and Reels watch time (issue #1159, which
-- folds in #1151 and #1155). Idempotent; applied files stay untouched.
--
-- crove_social.report_link.label_id
--                                the label a link reports on (#1159), or NULL for every post as before. A composite
--                                FK to the org's labels, so a link names only a label of its own org. Deleting the
--                                label deletes its links (ON DELETE CASCADE), so their tokens open nothing, as a
--                                revoked link's; never ON DELETE SET NULL, which would widen a campaign report to every
--                                post. Under a label the report counts neither outside posts nor goals, as the Metrics
--                                tab does; a CHECK keeps such a link from asking for outside posts.
-- crove_social.report_link.include_audience
--                                whether the report shows who follows its channels (#1155); on by default, so existing
--                                links and those a report schedule makes (#704) keep showing it.
--                                Both columns are set once by social.report_link.create: crove_tenant's UPDATE on the
--                                table stays revoked_at and revoked_by only, and no grant changes.
-- crove_social.report_link_view  as before, with the same signature, RETURNS and grants. The body is copied verbatim
--                                from 20261029100000_crove_social_follower_demographics.sql, with only this added:
--                                under a label, only the Crove posts with it count, in both periods, with no outside
--                                posts and no goals; an empty audience list when the link leaves it out;
--                                totalWatchTimeMs among the summed counts; and a 'reels' object, the period's Reels
--                                and the median of their average watch time (never summed). A link without a label,
--                                with the audience, on posts without watch time, gives exactly the previous output
--                                but for the 'reels' object.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_social.report_link ADD COLUMN IF NOT EXISTS label_id uuid;
ALTER TABLE crove_social.report_link ADD COLUMN IF NOT EXISTS include_audience boolean NOT NULL DEFAULT true;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'report_link_label_fk' AND conrelid = 'crove_social.report_link'::regclass) THEN
    ALTER TABLE crove_social.report_link ADD CONSTRAINT report_link_label_fk
      FOREIGN KEY (org_id, label_id) REFERENCES crove_social.label (org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'report_link_label_external' AND conrelid = 'crove_social.report_link'::regclass) THEN
    ALTER TABLE crove_social.report_link ADD CONSTRAINT report_link_label_external CHECK (label_id IS NULL OR NOT include_external);
  END IF;
END $$;
-- A label's deletion finds its links.
CREATE INDEX IF NOT EXISTS report_link_label_idx ON crove_social.report_link (org_id, label_id) WHERE label_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_social.report_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.report_link;
  -- Monthly goals (#1056): the zone the org's goals are counted in, and the month the period is, when it is exactly one.
  v_tz text;
  v_local timestamp;
  v_month text;
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
  -- The goals' zone is the same on every goal of the org (social.goal.set keeps it so).
  SELECT g.time_zone INTO v_tz FROM crove_social.goal g WHERE g.org_id = v_link.org_id ORDER BY g.created_at LIMIT 1;
  IF v_tz IS NOT NULL THEN
    BEGIN
      v_local := v_link.period_start AT TIME ZONE v_tz;
      -- A timestamp without a zone: date_trunc and the month added do not depend on the session's zone.
      IF v_local = pg_catalog.date_trunc('month', v_local) AND (v_local + interval '1 month') AT TIME ZONE v_tz = v_link.period_end THEN
        v_month := pg_catalog.to_char(v_local, 'YYYY-MM');
      END IF;
    EXCEPTION WHEN invalid_parameter_value THEN
      -- A zone this server does not know: no goals rather than no report.
      v_month := NULL;
    END;
  END IF;
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
               coalesce(s.metrics, '{}'::jsonb) AS metrics, false AS external
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
          -- A link of one label (#1159): only the posts with it, in both periods.
          AND (v_link.label_id IS NULL OR EXISTS (
            SELECT 1 FROM crove_social.post_label pl
            WHERE pl.org_id = v.org_id AND pl.post_id = v.post_id AND pl.label_id = v_link.label_id))
        ORDER BY v.published_at DESC
        LIMIT 5000
      ) x
      UNION ALL
      -- With the link's option (#1054): what its channels published outside Crove in each period, with the latest real
      -- counts, leaving out a post that is Crove's own (external_post_is_crove: it is counted once, as Crove's).
      SELECT p.cur, p.ps, p.pe, y.*
      FROM p CROSS JOIN LATERAL (
        SELECT e.id, c.provider, e.channel_connection_id AS conn, e.excerpt AS body, e.published_at, e.permalink AS external_url,
               e.metrics, true AS external
        FROM crove_social.external_post e
        JOIN crove_kernel.channel_connection c ON c.org_id = e.org_id AND c.id = e.channel_connection_id
        WHERE v_link.include_external AND v_link.label_id IS NULL
          AND e.org_id = v_link.org_id
          AND e.published_at >= p.ps AND e.published_at < p.pe
          AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR e.channel_connection_id = ANY (v_link.connection_ids))
          AND NOT crove_social.external_post_is_crove(e.org_id, e.channel_connection_id, e.external_post_id, e.permalink)
        ORDER BY e.published_at DESC
        LIMIT 5000
      ) y
    ),
    n AS (
      -- The counts Crove knows (METRIC_NAMES of packages/channel), as numbers; anything else a snapshot holds is left out.
      SELECT v.cur, v.id, v.conn, e.key, (e.value #>> '{}')::numeric AS value
      FROM v, pg_catalog.jsonb_each(v.metrics) e
      WHERE pg_catalog.jsonb_typeof(e.value) = 'number'
        AND e.key IN ('impressions', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'views',
                      'replies', 'tapsForward', 'tapsBack', 'exits', 'nextStory', 'follows', 'profileVisits',
                      'totalWatchTimeMs')
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
    ),
    gs AS (
      -- The goals the report shows, only for a month: the org's own when it covers every channel, and those of each
      -- channel it covers.
      SELECT g.connection_id AS conn, g.created_at, g.posts, g.reach, g.impressions, g.engagement, g.followers_gained, c.display_name, c.provider
      FROM crove_social.goal g
      LEFT JOIN crove_kernel.channel_connection c ON c.org_id = g.org_id AND c.id = g.connection_id
      WHERE v_month IS NOT NULL AND v_link.label_id IS NULL AND g.org_id = v_link.org_id
        AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR g.connection_id = ANY (v_link.connection_ids))
      ORDER BY g.connection_id IS NOT NULL, c.display_name, g.created_at
      LIMIT 100
    ),
    fs AS (
      -- Follower counts of the report's channels, by UTC day (its midday in or before the period), from a month before.
      SELECT s.channel_connection_id AS conn, s.captured_on, s.followers, (s.captured_on + time '12:00') AT TIME ZONE 'UTC' AS midday
      FROM crove_social.account_snapshot s
      WHERE v_month IS NOT NULL AND s.org_id = v_link.org_id AND s.followers IS NOT NULL
        AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR s.channel_connection_id = ANY (v_link.connection_ids))
        AND s.captured_on >= (v_link.period_start AT TIME ZONE 'UTC')::date - 32
        AND s.captured_on <= (v_link.period_end AT TIME ZONE 'UTC')::date
    ),
    gained AS (
      -- Followers gained per channel: the period's last count against the last one in the 31 days before it, or the
      -- period's first (goals.ts in modules/social counts them the same way).
      SELECT l.conn, l.followers - coalesce(b.followers, f.followers) AS gained
      FROM (SELECT DISTINCT ON (fs.conn) fs.conn, fs.followers FROM fs WHERE fs.midday >= v_link.period_start AND fs.midday < v_link.period_end ORDER BY fs.conn, fs.captured_on DESC) l
      JOIN (SELECT DISTINCT ON (fs.conn) fs.conn, fs.followers FROM fs WHERE fs.midday >= v_link.period_start AND fs.midday < v_link.period_end ORDER BY fs.conn, fs.captured_on) f ON f.conn = l.conn
      LEFT JOIN (
        SELECT DISTINCT ON (fs.conn) fs.conn, fs.followers FROM fs
        WHERE fs.midday < v_link.period_start AND fs.midday >= v_link.period_start - pg_catalog.make_interval(secs => 31 * 86400)
        ORDER BY fs.conn, fs.captured_on DESC
      ) b ON b.conn = l.conn
    ),
    pc AS (
      -- Posts and counts of the period per channel, once, for the goals.
      SELECT v.conn, pg_catalog.count(*) AS posts FROM v WHERE v.cur GROUP BY v.conn
    ),
    nc AS (
      SELECT n.conn,
             pg_catalog.sum(n.value) FILTER (WHERE n.key = 'reach') AS reach,
             pg_catalog.sum(n.value) FILTER (WHERE n.key = 'impressions') AS impressions,
             pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('reactions', 'comments', 'shares', 'saves', 'clicks')) AS engagement
      FROM n WHERE n.cur GROUP BY n.conn
    ),
    ga AS (
      -- Each goal's counts in the period, as the report adds them up: a count no post reported is null when something
      -- went out and 0 when nothing did; engagement is reactions, comments, shares, saves and clicks.
      SELECT gs.*, coalesce(a.posts, 0) AS a_posts,
             CASE WHEN coalesce(a.posts, 0) = 0 THEN 0 ELSE a.reach END AS a_reach,
             CASE WHEN coalesce(a.posts, 0) = 0 THEN 0 ELSE a.impressions END AS a_impressions,
             CASE WHEN coalesce(a.posts, 0) = 0 THEN 0 ELSE a.engagement END AS a_engagement,
             CASE WHEN gs.conn IS NULL THEN (SELECT pg_catalog.sum(x.gained) FROM gained x) ELSE (SELECT x.gained FROM gained x WHERE x.conn = gs.conn) END AS a_followers
      FROM gs CROSS JOIN LATERAL (
        SELECT pg_catalog.sum(pc.posts) AS posts, pg_catalog.sum(nc.reach) AS reach, pg_catalog.sum(nc.impressions) AS impressions, pg_catalog.sum(nc.engagement) AS engagement
        FROM pc LEFT JOIN nc ON nc.conn = pc.conn
        WHERE gs.conn IS NULL OR pc.conn = gs.conn
      ) a
    )
    SELECT pg_catalog.jsonb_build_object(
      'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
      -- The white-label branding of the link's own org (#1053), or null.
      'brand', crove_social.report_brand(v_link.org_id),
      'title', v_link.title,
      'periodStart', v_link.period_start,
      'periodEnd', v_link.period_end,
      'expiresAt', v_link.expires_at,
      'includesExternal', v_link.include_external,
      -- The agency's note (#1056), plain text.
      'note', v_link.note,
      -- The monthly goals (#1056), only when the period is exactly one month in the goals' zone; null otherwise.
      'goals', CASE WHEN v_month IS NULL OR NOT EXISTS (SELECT 1 FROM ga) THEN NULL ELSE pg_catalog.jsonb_build_object(
        'month', v_month,
        'timeZone', v_tz,
        'groups', (
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'channel', ga.display_name,
            'provider', ga.provider,
            'items', (
              SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('metric', x.metric, 'target', x.target, 'actual', x.actual) ORDER BY x.n), '[]'::jsonb)
              FROM (VALUES (1, 'posts', ga.posts::numeric, ga.a_posts::numeric), (2, 'reach', ga.reach::numeric, ga.a_reach),
                           (3, 'impressions', ga.impressions::numeric, ga.a_impressions), (4, 'engagement', ga.engagement::numeric, ga.a_engagement),
                           (5, 'followersGained', ga.followers_gained::numeric, ga.a_followers::numeric)) x(n, metric, target, actual)
              WHERE x.target IS NOT NULL
            )
          ) ORDER BY ga.conn IS NOT NULL, ga.display_name, ga.created_at)
          FROM ga
        )
      ) END,
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
      -- Who follows each of the report's channels (#1146): the latest audience taken on a UTC day whose midday is in
      -- the period, a channel without one left out ({} is an ask that got nothing).
      'audience', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', c.provider,
          'day', pg_catalog.to_char(a.captured_on, 'YYYY-MM-DD'),
          'audience', a.audience
        ) ORDER BY c.display_name, a.conn)
        FROM (
          SELECT DISTINCT ON (s.channel_connection_id) s.channel_connection_id AS conn, s.captured_on, s.audience
          FROM crove_social.account_snapshot s
          WHERE v_link.include_audience
            AND s.org_id = v_link.org_id AND s.audience IS NOT NULL AND s.audience <> '{}'::jsonb
            AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR s.channel_connection_id = ANY (v_link.connection_ids))
            AND (s.captured_on + time '12:00') AT TIME ZONE 'UTC' >= v_link.period_start
            AND (s.captured_on + time '12:00') AT TIME ZONE 'UTC' < v_link.period_end
          ORDER BY s.channel_connection_id, s.captured_on DESC
          LIMIT 200
        ) a
        JOIN crove_kernel.channel_connection c ON c.org_id = v_link.org_id AND c.id = a.conn
      ), '[]'::jsonb),
      -- The period's Reels (#1151): Crove's posts of type reel (settings.postType, as postTypeOf reads it) or with a
      -- Reels watch time (asked of Reels only, a feed post of one video included, which Instagram publishes as one; #1147), and the
      -- median of their average watch time, in whole milliseconds, over those that report one (null when none does). An
      -- average per post is never summed; the total watch time is among the summed counts above.
      'reels', (
        SELECT pg_catalog.jsonb_build_object(
          'posts', pg_catalog.count(*),
          'medianAvgWatchTimeMs', pg_catalog.round((pg_catalog.percentile_cont(0.5) WITHIN GROUP (ORDER BY r.avg_ms) FILTER (WHERE r.avg_ms >= 0))::numeric)
        )
        FROM (
          -- As a number, capped so a huge one cannot overflow the double precision the median takes.
          SELECT CASE WHEN pg_catalog.jsonb_typeof(v.metrics -> 'avgWatchTimeMs') = 'number'
                      THEN LEAST((v.metrics ->> 'avgWatchTimeMs')::numeric, 1e15)::double precision END AS avg_ms
          FROM v
          JOIN crove_social.post_variant pv ON pv.org_id = v_link.org_id AND pv.id = v.id
          WHERE v.cur AND NOT v.external AND (pv.settings ->> 'postType' = 'reel' OR v.metrics ? 'avgWatchTimeMs')
        ) r
      ),
      'top', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', v.provider,
          'excerpt', pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(v.body, '\s+', ' ', 'g')), 200),
          'publishedAt', v.published_at,
          'url', CASE WHEN v.external_url ~ '^https://' THEN v.external_url END,
          'external', v.external,
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
