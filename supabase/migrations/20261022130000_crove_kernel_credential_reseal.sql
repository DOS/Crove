-- Resealing channel credentials after a key rotation (#776, ADR-0025 "a reseal command for rotations"). Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.credential_reseal_due: the worker's scan, across active orgs, of credentials of active connections sealed
-- with a key other than the given (current) one. It returns ids and key ids only: the worker reads each envelope
-- through credential_get in the system context of its org, opens it with the previous key, seals it with the current one
-- and stores it through kernel.channel.reseal, which checks the envelope still carries the key it read.
-- crove_kernel.credential_key_counts: how many envelopes each key id still seals, of active connections and of the
-- others (expired, in error, revoked: those reseal when they are reconnected). A key id reveals nothing about its key.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.credential_reseal_due(p_key_id text, p_limit int)
RETURNS TABLE (org_id uuid, connection_id uuid, key_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.connection_id, k.key_id
  FROM crove_kernel.credential k
  JOIN crove_kernel.channel_connection c ON c.org_id = k.org_id AND c.id = k.connection_id
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status = 'active'
  WHERE k.key_id <> p_key_id AND c.status = 'active'
  ORDER BY k.sealed_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.credential_key_counts()
RETURNS TABLE (key_id text, active bigint, inactive bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.key_id, count(*) FILTER (WHERE c.status = 'active'), count(*) FILTER (WHERE c.status <> 'active')
  FROM crove_kernel.credential k
  JOIN crove_kernel.channel_connection c ON c.org_id = k.org_id AND c.id = k.connection_id
  GROUP BY k.key_id
$$;

REVOKE ALL ON FUNCTION crove_kernel.credential_reseal_due(text, int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.credential_key_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_reseal_due(text, int) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_key_counts() TO crove_worker;
