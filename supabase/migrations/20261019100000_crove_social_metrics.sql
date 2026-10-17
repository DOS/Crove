-- Metrics of published posts (Social plan S8, issue #238). Idempotent; applied files stay untouched.
--
-- crove_social.metric_snapshot  what a platform reported for a published variant at one capture: normalized counts
--                               in `metrics` (impressions, reach, reactions, comments, shares, saves, clicks, views),
--                               whatever else the platform gave in `extra`. Append-only, one row per capture key, so a
--                               repeated capture is a no-op and the history shows how a post did over time.
-- crove_social.metrics_due      the worker's scan, across orgs, of variants published in the last 30 days whose last
--                               capture (an answer, or a failed try kept as an empty snapshot) is older than the
--                               interval, leaving out posts the platform said are gone. It returns ids only.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.metric_snapshot (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  variant_id uuid NOT NULL,
  -- The capture this row is for, e.g. 2026-10-18T06 (a 6-hour bucket): the worker never writes a bucket twice.
  capture_key text NOT NULL CHECK (length(capture_key) BETWEEN 1 AND 100),
  captured_at timestamptz NOT NULL DEFAULT now(),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object' AND octet_length(metrics::text) <= 8192),
  extra jsonb CHECK (extra IS NULL OR (jsonb_typeof(extra) = 'object' AND octet_length(extra::text) <= 16384)),
  PRIMARY KEY (org_id, id),
  CONSTRAINT metric_snapshot_variant_fk FOREIGN KEY (org_id, variant_id) REFERENCES crove_social.post_variant (org_id, id) ON DELETE CASCADE,
  CONSTRAINT metric_snapshot_capture_uq UNIQUE (org_id, variant_id, capture_key)
);
CREATE INDEX IF NOT EXISTS metric_snapshot_latest_idx ON crove_social.metric_snapshot (org_id, variant_id, captured_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_social.metric_snapshot', true);

CREATE OR REPLACE FUNCTION crove_social.metrics_due(p_limit int, p_providers text[], p_interval_seconds int)
RETURNS TABLE (org_id uuid, variant_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.org_id, v.id, v.provider
  FROM crove_social.post_variant v
  JOIN crove_kernel.tenant t ON t.org_id = v.org_id AND t.status = 'active'
  JOIN crove_kernel.channel_connection c ON c.org_id = v.org_id AND c.id = v.channel_connection_id AND c.status = 'active'
  LEFT JOIN LATERAL (
    SELECT max(s.captured_at) AS at FROM crove_social.metric_snapshot s WHERE s.org_id = v.org_id AND s.variant_id = v.id
  ) last ON true
  WHERE v.status = 'published'
    AND v.provider = ANY (p_providers)
    AND v.external_post_id IS NOT NULL
    AND v.published_at > pg_catalog.now() - interval '30 days'
    AND (last.at IS NULL OR last.at < pg_catalog.now() - pg_catalog.make_interval(secs => GREATEST(p_interval_seconds, 600)))
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.metric_snapshot g
      WHERE g.org_id = v.org_id AND g.variant_id = v.id AND g.extra ->> 'gone' = 'true'
    )
  ORDER BY last.at NULLS FIRST, v.published_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION crove_social.metrics_due(int, text[], int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.metrics_due(int, text[], int) TO crove_worker;
