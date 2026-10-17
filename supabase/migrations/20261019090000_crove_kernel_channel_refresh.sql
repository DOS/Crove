-- Token refresh for channel connections (Social plan §3.5, step S6.4, issue #374). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.channel_refresh_due: the worker's scan, across orgs, of active connections of the given providers whose
-- access token expires within the horizon. It returns ids and the row version only; the refresh reads the credential
-- through credential_get in the system context of each org and stores the new one through kernel.channel.refresh.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS channel_connection_refresh_idx
  ON crove_kernel.channel_connection (provider, expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_kernel.channel_refresh_due(p_limit int, p_providers text[], p_horizon_seconds int)
RETURNS TABLE (org_id uuid, connection_id uuid, provider text, version timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id, c.provider, c.updated_at
  FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE c.status = 'active'
    AND c.provider = ANY (p_providers)
    AND c.expires_at IS NOT NULL
    AND c.expires_at < pg_catalog.now() + pg_catalog.make_interval(secs => LEAST(GREATEST(p_horizon_seconds, 60), 7 * 86400))
  ORDER BY c.expires_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION crove_kernel.channel_refresh_due(int, text[], int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.channel_refresh_due(int, text[], int) TO crove_worker;
