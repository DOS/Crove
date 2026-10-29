-- Crove social (issue #1889, from the review of #1878): the credential reseal after a key rotation reseals the team
-- chat alert targets of orgs being offboarded too, as chat_alert_target_key_counts counts them. Idempotent; applied files
-- stay untouched. The kernel's credentials take the same change in 20261105150000_crove_kernel_reseal_offboarding.sql,
-- whose header gives the reasons: an offboarding org's envelopes were counted but never resealed, and staff can reopen
-- such an org before its purge; the worker's system context enters it; a closed org keeps no target after its purge.
--
-- The function keeps its signature, owner and grants (EXECUTE for crove_worker alone); only the status filter changes.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_social.chat_alert_target_reseal_due(p_key_id text, p_limit int, p_after_sealed timestamptz, p_after_id uuid)
RETURNS TABLE (org_id uuid, alert_id uuid, key_id text, sealed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.org_id, k.alert_id, k.key_id, k.sealed_at
  FROM crove_social.chat_alert_target k
  JOIN crove_kernel.tenant t ON t.org_id = k.org_id AND t.status IN ('active', 'offboarding')
  WHERE k.key_id <> p_key_id
    AND crove_social.chat_alert_target_usable(k.org_id, k.alert_id)
    AND (p_after_sealed IS NULL OR (k.sealed_at, k.alert_id) > (p_after_sealed, p_after_id))
  ORDER BY k.sealed_at, k.alert_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION crove_social.chat_alert_target_reseal_due(text, int, timestamptz, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_social.chat_alert_target_reseal_due(text, int, timestamptz, uuid) TO crove_worker;
