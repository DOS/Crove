-- Resealing channel credentials after a key rotation (#776, ADR-0025 "a reseal command for rotations"). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.credential_reseal_due: the worker's scan, across active orgs, of credentials sealed with a key other
-- than the given (current) one, of active connections whose connecting member may still use them (the same rule as
-- credential_get). It returns ids and key ids only, in pages after a (sealed_at, connection_id) cursor, so a row that
-- cannot be resealed never holds back the ones after it. The worker reads each envelope through credential_get in the
-- system context of its org, opens it with the previous key, seals it with the current one and stores it through
-- kernel.channel.reseal, which checks the envelope is still the one it read.
-- crove_kernel.credential_key_counts: how many envelopes each key id still seals, of usable connections (resealed by
-- the worker) and of the others (expired, in error or revoked, or whose member left: those reseal when reconnected).
-- A key id reveals nothing about its key.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.credential_usable(p_org_id uuid, p_connection_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM crove_kernel.channel_connection c
    JOIN crove_kernel.tenant_member m ON m.org_id = c.org_id AND m.user_id = c.connected_by AND m.role IN ('owner', 'admin')
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE c.org_id = p_org_id AND c.id = p_connection_id AND c.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION crove_kernel.credential_reseal_due(p_key_id text, p_limit int, p_after_sealed timestamptz, p_after_id uuid)
RETURNS TABLE (org_id uuid, connection_id uuid, key_id text, sealed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.connection_id, k.key_id, k.sealed_at
  FROM crove_kernel.credential k
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status = 'active'
  WHERE k.key_id <> p_key_id
    AND crove_kernel.credential_usable(k.org_id, k.connection_id)
    AND (p_after_sealed IS NULL OR (k.sealed_at, k.connection_id) > (p_after_sealed, p_after_id))
  ORDER BY k.sealed_at, k.connection_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.credential_key_counts()
RETURNS TABLE (key_id text, active bigint, inactive bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.key_id,
    count(*) FILTER (WHERE crove_kernel.credential_usable(k.org_id, k.connection_id)),
    count(*) FILTER (WHERE NOT crove_kernel.credential_usable(k.org_id, k.connection_id))
  FROM crove_kernel.credential k
  GROUP BY k.key_id
$$;

REVOKE ALL ON FUNCTION crove_kernel.credential_usable(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.credential_reseal_due(text, int, timestamptz, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.credential_key_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_reseal_due(text, int, timestamptz, uuid) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_key_counts() TO crove_worker;
