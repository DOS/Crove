-- Org purge (issue #1726, from the review of #1864): a restore's re-record of an export is not a new export. Idempotent;
-- applied files stay untouched.
--
-- Since #1726 a restore re-records an org's newest export as a rebind (kernel.org.export.record with rebind: true, a
-- system audit row whose detail says so) even when the export predates a table added since. The purge took the newest
-- system export row as the export's date, so a rebind moved it: the owner asks for a fresh export at T1 after export
-- A, a restore re-records A at T2 > T1, the export job queued at T1 fails for good, and 30 days later the purge passed
-- on A, though data changed between A and T1 was never exported. org_purge_refusal and org_purge_check now leave the
-- rebind rows out: the export's date is that of the export's own record, so a request after it stays 'export_pending'
-- and the 30-day wait counts from the export, not from the restore. Copied from 20261028130000_crove_kernel_org_purge.sql
-- (the newest definitions) with that condition added; org_purge calls org_purge_refusal under the tenant row's lock.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.org_purge_refusal(p_org_id uuid, p_min_days integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_status text;
  v_exported timestamptz;
BEGIN
  IF p_min_days IS NULL OR p_min_days < 30 OR p_min_days > 3650 THEN
    RETURN 'invalid';
  END IF;
  SELECT t.status INTO v_status FROM crove_kernel.tenant t WHERE t.org_id = p_org_id;
  IF v_status IS NULL THEN
    RETURN 'not_found';
  ELSIF v_status = 'closed' THEN
    RETURN 'closed';
  ELSIF v_status <> 'offboarding' THEN
    RETURN 'not_offboarding';
  END IF;
  SELECT a.occurred_at INTO v_exported FROM crove_kernel.audit_event a
  WHERE a.org_id = p_org_id AND a.command = 'kernel.org.export.record' AND a.outcome = 'ok' AND a.actor_type = 'system'
    AND a.detail ->> 'format' = 'crove.org-export.v2' AND (a.detail -> 'rebind') IS NULL
  ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1;
  IF v_exported IS NULL THEN
    RETURN 'export_missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = p_org_id AND a.command = 'kernel.org.offboard' AND a.outcome = 'ok' AND a.actor_type = 'user'
      AND a.occurred_at > v_exported
  ) THEN
    RETURN 'export_pending';
  END IF;
  IF v_exported > pg_catalog.now() - pg_catalog.make_interval(days => p_min_days) THEN
    RETURN 'too_early';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.org_purge_check(p_ref text)
RETURNS TABLE (outcome text, org_id uuid, status text, exported_at timestamptz, refusal text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ref text := pg_catalog.btrim(coalesce(p_ref, ''));
  v_org uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ORG_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_ref = '' OR pg_catalog.length(v_ref) > 200 THEN
    outcome := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT t.org_id INTO v_org FROM crove_kernel.tenant t WHERE t.org_id = v_ref::uuid;
  ELSE
    SELECT t.org_id INTO v_org FROM crove_kernel.tenant t WHERE t.slug = pg_catalog.lower(v_ref);
  END IF;
  IF v_org IS NULL THEN
    outcome := 'not_found';
    RETURN NEXT;
    RETURN;
  END IF;
  outcome := 'ok';
  org_id := v_org;
  SELECT t.status INTO status FROM crove_kernel.tenant t WHERE t.org_id = v_org;
  SELECT a.occurred_at INTO exported_at FROM crove_kernel.audit_event a
  WHERE a.org_id = v_org AND a.command = 'kernel.org.export.record' AND a.outcome = 'ok' AND a.actor_type = 'system'
    AND a.detail ->> 'format' = 'crove.org-export.v2' AND (a.detail -> 'rebind') IS NULL
  ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1;
  refusal := crove_kernel.org_purge_refusal(v_org, 30);
  RETURN NEXT;
END $$;

-- EXECUTE matrix, as in 20261028130000: the check for the worker login only, the refusal for nobody.
REVOKE ALL ON FUNCTION crove_kernel.org_purge_refusal(uuid, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_kernel.org_purge_check(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.org_purge_check(text) TO crove_worker;
