-- The metrics sweep at scale (#397). crove_social.metrics_due reads, across orgs, the variants published in the last
-- 30 days and skips the ones marked gone; both reads get a partial index, which narrows the scan as the tables grow (the
-- order by last capture still sorts the candidates).
--
-- post_variant_metrics_due_idx   published variants with a platform id, by publish time.
-- metric_snapshot_gone_idx       the snapshots that mark a post gone (asked never again).

SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS post_variant_metrics_due_idx ON crove_social.post_variant (published_at)
  WHERE status = 'published' AND external_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS metric_snapshot_gone_idx ON crove_social.metric_snapshot (org_id, variant_id)
  WHERE extra ->> 'gone' = 'true';
