-- Staged upload follow-ups (issue #223, ADR-0013). Idempotent; applied files stay untouched.
--
-- 1. Indexes for the per-user grant rate in kernel.file.upload.begin (grants created in the last minute) and for the
--    retention purge of old grants (by age).
-- 2. crove_kernel.retention_purge() gains a fourth store: crove_kernel.file_upload rows created more than 7 days ago.
--    A grant expires 5 minutes after it is created (file_upload_window), so every such row is used or expired and
--    nothing can claim it any more. The audit rows keep the grant id (upload_id). The other three stores are
--    unchanged; the function is restated whole.
--
-- Tenant roles still cannot delete a grant: the purge runs as the table owner (SECURITY DEFINER), executable by
-- crove_worker alone, and checks session_user as before.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS file_upload_recent_idx ON crove_kernel.file_upload (org_id, created_by, created_at);
CREATE INDEX IF NOT EXISTS file_upload_created_idx ON crove_kernel.file_upload (created_at);

CREATE OR REPLACE FUNCTION crove_kernel.retention_purge(p_batch int DEFAULT 10000)
RETURNS TABLE (store text, deleted int, more boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_batch int := LEAST(GREATEST(COALESCE(p_batch, 10000), 1), 10000);
  v_now timestamptz := pg_catalog.now();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'RETENTION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  store := 'kernel.idempotency_key';
  DELETE FROM crove_kernel.idempotency_key k
  WHERE (k.org_id, k.actor_key, k.key) IN (
    SELECT e.org_id, e.actor_key, e.key FROM crove_kernel.idempotency_key e
    WHERE e.created_at < v_now - interval '7 days'
    LIMIT v_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  more := EXISTS (SELECT 1 FROM crove_kernel.idempotency_key e WHERE e.created_at < v_now - interval '7 days');
  RETURN NEXT;

  store := 'kernel.inbound_drop';
  DELETE FROM crove_kernel.inbound_drop d
  WHERE (d.org_id, d.address_id) IN (
    SELECT e.org_id, e.address_id FROM crove_kernel.inbound_drop e
    WHERE e.last_dropped_at < v_now - interval '30 days'
    LIMIT v_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  more := EXISTS (SELECT 1 FROM crove_kernel.inbound_drop e WHERE e.last_dropped_at < v_now - interval '30 days');
  RETURN NEXT;

  store := 'kernel.member_invite';
  DELETE FROM crove_kernel.member_invite i
  WHERE (i.org_id, i.id) IN (
    SELECT e.org_id, e.id FROM crove_kernel.member_invite e
    WHERE COALESCE(e.accepted_at, e.revoked_at, e.expires_at) < v_now - interval '90 days'
    LIMIT v_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  more := EXISTS (
    SELECT 1 FROM crove_kernel.member_invite e WHERE COALESCE(e.accepted_at, e.revoked_at, e.expires_at) < v_now - interval '90 days'
  );
  RETURN NEXT;

  -- Staged upload grants (ADR-0013): used or expired long ago, never an open one.
  store := 'kernel.file_upload';
  DELETE FROM crove_kernel.file_upload u
  WHERE (u.org_id, u.id) IN (
    SELECT e.org_id, e.id FROM crove_kernel.file_upload e
    WHERE e.created_at < v_now - interval '7 days'
      AND (e.used_at IS NOT NULL OR e.expires_at < v_now)
    LIMIT v_batch FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  more := EXISTS (
    SELECT 1 FROM crove_kernel.file_upload e
    WHERE e.created_at < v_now - interval '7 days' AND (e.used_at IS NOT NULL OR e.expires_at < v_now)
  );
  RETURN NEXT;
END $$;

-- EXECUTE matrix, restated: the worker alone.
REVOKE ALL ON FUNCTION crove_kernel.retention_purge(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.retention_purge(int) TO crove_worker;

-- Grant privileges, restated (unchanged): tenant roles create and claim grants through commands and never delete one.
REVOKE ALL ON crove_kernel.file_upload FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON crove_kernel.file_upload FROM crove_tenant;
GRANT SELECT, INSERT ON crove_kernel.file_upload TO crove_tenant;
GRANT UPDATE (used_at) ON crove_kernel.file_upload TO crove_tenant;
