-- Account growth of Social channels (issue #645). Idempotent; applied files stay untouched.
--
-- crove_social.account_snapshot    what a platform reported about a connected account on one day (UTC): its followers,
--                                  and the reach of the last day where the platform gives it. Taken by the worker
--                                  through each adapter that can (accountMetrics); a try that got no answer is kept
--                                  with no counts, so the channel waits for the next day instead of being asked again.
--                                  Append-only, one row per channel and day.
-- crove_social.account_snapshots_due  the worker's scan, across orgs, of active channels of active orgs on the given
--                                  providers with no snapshot for today. It returns ids only.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_social.account_snapshot (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  channel_connection_id uuid NOT NULL,
  captured_on date NOT NULL,
  followers bigint CHECK (followers IS NULL OR followers >= 0),
  reach bigint CHECK (reach IS NULL OR reach >= 0),
  -- Why there are no counts: the platform did not answer, or refused the token or the permission.
  error text CHECK (error IS NULL OR error IN ('no_answer', 'token_expired', 'permission')),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT account_snapshot_connection_fk FOREIGN KEY (org_id, channel_connection_id) REFERENCES crove_kernel.channel_connection (org_id, id) ON DELETE CASCADE,
  CONSTRAINT account_snapshot_day_uq UNIQUE (org_id, channel_connection_id, captured_on)
);
CREATE INDEX IF NOT EXISTS account_snapshot_day_idx ON crove_social.account_snapshot (org_id, captured_on);
SELECT crove_kernel.apply_tenant_rls('crove_social.account_snapshot', true);

CREATE OR REPLACE FUNCTION crove_social.account_snapshots_due(p_limit int, p_providers text[])
RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider
  FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.status = 'active'
    AND c.provider = ANY (p_providers)
    AND NOT EXISTS (
      SELECT 1 FROM crove_social.account_snapshot s
      WHERE s.org_id = c.org_id AND s.channel_connection_id = c.id AND s.captured_on = (pg_catalog.now() AT TIME ZONE 'UTC')::date
    )
  ORDER BY c.org_id, c.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION crove_social.account_snapshots_due(int, text[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.account_snapshots_due(int, text[]) TO crove_worker;
