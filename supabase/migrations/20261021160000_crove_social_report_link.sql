-- Crove Social: client report links (issue #643). Idempotent.
--
-- An agency sends a client a link to a report of a period: what went out on the chosen channels (all of them when none
-- are chosen), the totals of the latest counts, the counts per channel and the posts that did best. No account; it
-- prints cleanly to PDF from the browser.
--
-- report_link  one link: the SHA-256 of its token (the secret is only in the URL the creator copies, after the #), an
--              optional title, the period [period_start, period_end) (at most 366 days; the CHECK allows a day more for daylight saving), the channels, its expiry (at
--              most 90 days) and its revocation. Owners and admins make and revoke links through commands; nothing else
--              about a link changes.
--
-- report_link_view(token)  for a live link (well-formed token, not revoked, not expired, active org): the report as
--                          JSON; NULL otherwise. Nothing else of the org: no ids, no people, no drafts, no other period.
-- Only crove_app (the API login role, which serves the public report page) may execute it.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.report_link (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  token_sha256 text NOT NULL CONSTRAINT report_link_token_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- None: every channel of the org.
  connection_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(connection_ids) <= 50),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT report_link_token_uq UNIQUE (token_sha256),
  CONSTRAINT report_link_period CHECK (period_end > period_start AND period_end <= period_start + interval '367 days'),
  CONSTRAINT report_link_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '91 days'),
  CONSTRAINT report_link_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS report_link_created_idx ON crove_social.report_link (org_id, created_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_social.report_link');
REVOKE UPDATE, DELETE ON crove_social.report_link FROM crove_tenant;
GRANT UPDATE (revoked_at, revoked_by) ON crove_social.report_link TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_social.report_link_view(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_link crove_social.report_link;
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
  RETURN (
    WITH v AS (
      -- What went out in the period on the link's channels, with the latest real counts of each.
      SELECT v.id, v.provider, v.channel_connection_id AS conn, coalesce(v.body, p.body) AS body, v.published_at, v.external_url,
             coalesce(s.metrics, '{}'::jsonb) AS metrics
      FROM crove_social.post_variant v
      JOIN crove_social.post p ON p.org_id = v.org_id AND p.id = v.post_id
      LEFT JOIN LATERAL (
        SELECT m.metrics FROM crove_social.metric_snapshot m
        WHERE m.org_id = v.org_id AND m.variant_id = v.id
        ORDER BY (m.metrics = '{}'::jsonb), m.captured_at DESC LIMIT 1
      ) s ON true
      WHERE v.org_id = v_link.org_id AND v.status = 'published'
        AND v.published_at >= v_link.period_start AND v.published_at < v_link.period_end
        AND (pg_catalog.cardinality(v_link.connection_ids) = 0 OR v.channel_connection_id = ANY (v_link.connection_ids))
      ORDER BY v.published_at DESC
      LIMIT 5000
    ),
    n AS (
      -- The counts Crove knows (METRIC_NAMES of packages/channel), as numbers; anything else a snapshot holds is left out.
      SELECT v.id, v.conn, e.key, (e.value #>> '{}')::numeric AS value
      FROM v, pg_catalog.jsonb_each(v.metrics) e
      WHERE pg_catalog.jsonb_typeof(e.value) = 'number'
        AND e.key IN ('impressions', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'views')
    ),
    score AS (
      SELECT v.id, coalesce(pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('reactions', 'comments', 'shares', 'saves', 'clicks')), 0) AS engagement,
             coalesce(pg_catalog.sum(n.value) FILTER (WHERE n.key IN ('views', 'impressions', 'reach')), 0) AS seen
      FROM v LEFT JOIN n ON n.id = v.id
      GROUP BY v.id
    ),
    per_channel AS (
      SELECT v.conn, pg_catalog.count(*) AS posts FROM v GROUP BY v.conn
    )
    SELECT pg_catalog.jsonb_build_object(
      'org', (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = v_link.org_id),
      'title', v_link.title,
      'periodStart', v_link.period_start,
      'periodEnd', v_link.period_end,
      'expiresAt', v_link.expires_at,
      'posts', (SELECT pg_catalog.count(*) FROM v),
      'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n GROUP BY n.key) t), '{}'::jsonb),
      'channels', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'channel', c.display_name,
          'provider', c.provider,
          'posts', pc.posts,
          'totals', coalesce((SELECT pg_catalog.jsonb_object_agg(t.key, t.total) FROM (SELECT n.key, pg_catalog.sum(n.value) AS total FROM n WHERE n.conn = pc.conn GROUP BY n.key) t), '{}'::jsonb)
        ) ORDER BY pc.posts DESC, c.display_name)
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
          'metrics', coalesce((SELECT pg_catalog.jsonb_object_agg(n.key, n.value) FROM n WHERE n.id = v.id), '{}'::jsonb)
        ) ORDER BY s.engagement DESC, s.seen DESC, v.published_at DESC)
        FROM (SELECT * FROM score ORDER BY engagement DESC, seen DESC LIMIT 10) s
        JOIN v ON v.id = s.id
        JOIN crove_kernel.channel_connection c ON c.org_id = v_link.org_id AND c.id = v.conn
      ), '[]'::jsonb)
    )
  );
END $$;
REVOKE ALL ON FUNCTION crove_social.report_link_view(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.report_link_view(text) TO crove_app;
