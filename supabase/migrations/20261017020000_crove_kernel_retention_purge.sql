-- Retention purges for the TTL tables (issue #38, plan §4.9 retention table, §7.9). Idempotent; applied files stay
-- untouched.
--
-- crove_kernel.retention_purge(p_batch) deletes one batch of expired rows from each TTL store and reports, per store,
-- how many rows it deleted and whether expired rows remain. The worker calls it from a pg-boss schedule (Asia/
-- Ho_Chi_Minh), batch after batch until nothing expired remains; pg_cron is optional and not required.
--
-- What it purges (only these tables, only rows past their window, at most p_batch <= 10000 rows per table per call):
--   idempotency_key  7 days after created_at (plan §4.8: 7-day TTL). A replay after that runs the command again.
--   inbound_drop     30 days after the last counted drop. inbound_drop_count() reads only addresses retired less than
--                    30 days ago, and a drop is counted only after its address was retired, so such a row is never
--                    read again.
--   member_invite    90 days after the invite was accepted, revoked or expired. A pending invite that has not expired
--                    is never purged. Removes the invitee's email; the audit rows keep the invite id.
--
-- What it never touches: audit_event, outbox_event (business facts; purged only after the WORM archive exists, plan
-- §4.9), the ledger and every other crove_finance table, auth_session and auth_session_org (a revoked row is the
-- revocation list), inbound_address (tombstones are permanent), context_key. worker_heartbeat purges itself
-- (worker_beat), and pg-boss deletes its own jobs (deleteAfterSeconds).
--
-- Owned by the table owner (the migration runner), like inbound_drop_record, so it deletes without a grant and without
-- row-level security (the tables do not FORCE it). The plan names a crove_definer_system owner; that role does not exist
-- yet, and the owner already holds exactly these rights. DML only. Executable by crove_worker alone, and it checks
-- session_user too, so a definer running as a more privileged owner cannot be used to reach it from the API.
SET LOCAL lock_timeout = '2s';

-- The purge scans by age; without it every run reads the whole table.
CREATE INDEX IF NOT EXISTS idempotency_key_created_idx ON crove_kernel.idempotency_key (created_at);

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
END $$;

-- EXECUTE matrix: the worker alone.
REVOKE ALL ON FUNCTION crove_kernel.retention_purge(int) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.retention_purge(int) TO crove_worker;
