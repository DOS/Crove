-- Crove kernel (issue #1889, from the review of #1878): the credential reseal after a key rotation reseals the
-- envelopes of orgs being offboarded too, as it counts them. Idempotent; applied files stay untouched. The same change to
-- the social module's chat alert targets is 20261105160000_crove_social_chat_alert_reseal_offboarding.sql.
--
-- The counts (credential_key_counts, chat_alert_target_key_counts) take every org, but the scans that find what to
-- reseal (credential_reseal_due, chat_alert_target_reseal_due) took only orgs whose status is 'active'. A usable
-- credential or chat alert target of an org in 'offboarding' stayed counted as left to reseal and was never resealed,
-- so the runbook's "0 active left" could not be reached until the org was purged, and retiring the previous key early
-- would have lost envelopes such an org may still need (staff can reopen an offboarding org before its
-- purge). The worker's system context enters an offboarding org (enter_system_context admits 'active' and
-- 'offboarding'), so the scan now takes both statuses. A closed org has no envelope left: the purge deletes
-- crove_kernel.credential and crove_social.chat_alert_target with the rest of its rows (20261028130000).
--
-- The function keeps its signature, owner and grants (EXECUTE for crove_worker alone); only the status filter changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.credential_reseal_due(p_key_id text, p_limit int, p_after_sealed timestamptz, p_after_id uuid)
RETURNS TABLE (org_id uuid, connection_id uuid, key_id text, sealed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.connection_id, k.key_id, k.sealed_at
  FROM crove_kernel.credential k
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status IN ('active', 'offboarding')
  WHERE k.key_id <> p_key_id
    AND crove_kernel.credential_usable(k.org_id, k.connection_id)
    AND (p_after_sealed IS NULL OR (k.sealed_at, k.connection_id) > (p_after_sealed, p_after_id))
  ORDER BY k.sealed_at, k.connection_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION crove_kernel.credential_reseal_due(text, int, timestamptz, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.credential_reseal_due(text, int, timestamptz, uuid) TO crove_worker;
