-- Sweep of leftover raw inbound mail (issue #212). Idempotent; applied files stay untouched.
--
-- The worker deletes a raw message (inbound/<blob_id>) once it is filed or dropped, and keeps it after the last failed
-- attempt for investigation. The daily retention job now deletes such leftovers once they are older than the retention
-- window, but never a blob that is still waiting for the worker. Waiting means a row in crove_kernel.inbound_pending
-- (stored by the API, not yet claimed) or a live pg-boss job (the worker checks the job table itself). inbound_pending
-- has RLS on and no policy, so only definers read it; this one answers which of the given blob ids have a row there,
-- and nothing else (no row data, no count of other rows).
--
-- Worker only: EXECUTE for crove_worker alone, plus the same session_user check as retention_purge, so a definer
-- running as a more privileged owner cannot be used to reach it from the API.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.inbound_pending_blobs(p_blob_ids text[])
RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'RETENTION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.cardinality(p_blob_ids) > 10000 THEN
    RAISE EXCEPTION 'TOO_MANY_BLOB_IDS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.blob_id FROM crove_kernel.inbound_pending p WHERE p.blob_id = ANY (p_blob_ids);
END $$;

-- EXECUTE matrix: the worker alone.
REVOKE ALL ON FUNCTION crove_kernel.inbound_pending_blobs(text[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.inbound_pending_blobs(text[]) TO crove_worker;
