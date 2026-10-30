-- Crove kernel (issue #1951, plan §7.8): a system-context audit row names the worker process that wrote it, so a
-- detective alert can tie one worker process's activity across orgs together. Idempotent; applied files stay untouched.
--
-- audit_event_stamp, as in 20261102160000_crove_kernel_audit_stamp.sql, plus:
--   - a system context: detail.workerInstance is the session's application_name. The worker names its connections
--     'crove-worker:<instance>', the instance its heartbeat names (crove_kernel.worker_beat), so the row and the
--     heartbeat agree. Only a crove_worker session enters a system context (enter_system_context), so no tenant role
--     can write a system row, and so none can forge the name. The worker itself is trusted, as for every system row.
--     An empty application_name leaves the key out. Other worker-login processes stamp their own fixed names
--     ('crove-restore', 'crove-operator'). Behind a transaction-mode pooler that does not track application_name per
--     client, the server connection may carry another client's name; direct connections, the default, are exact.
--     Neither the org's audit log (auditDetailLine) nor its data export (kernel.org.export.snapshot) shows the key: it
--     is for the deployment's alerts.
--   - a user or an agent context: detail.workerInstance is removed, so no member's or agent's row claims a worker.
-- The key is inside detail, which the WORM stream already hashes in every batch version (archive_row_hashes), so the
-- name is anchored with the row and no new archive version is needed. Staff rows are still left as written. The
-- runtime keeps no key of that name in a command's own detail either (RESERVED_OK_KEYS, RESERVED_REFUSAL_KEYS).
-- audit_event_proposal fires before this trigger and judges detail.under_proposal (20261105070000): this one changes
-- the workerInstance key alone, never under_proposal, org_id, command or proposal_id, so that check still holds.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.audit_event_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_ctx jsonb;
  v_instance text;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_ctx := crove_kernel.ctx_verified();
  -- No context, or another org's: the tenant policy refuses the row (it applies to every role but staff), with its
  -- own error.
  IF v_ctx IS NULL OR (v_ctx ->> 'org')::uuid IS DISTINCT FROM NEW.org_id THEN
    RETURN NEW;
  END IF;
  -- Only a system row names a worker, and only the stamp writes the name.
  IF NEW.detail IS NOT NULL AND pg_catalog.jsonb_typeof(NEW.detail) = 'object' THEN
    NEW.detail := NEW.detail - 'workerInstance';
  END IF;
  IF v_ctx ->> 'actor' = 'user' THEN
    NEW.actor_type := 'user';
    NEW.actor_id := (v_ctx ->> 'user')::uuid;
  ELSIF v_ctx ->> 'actor' = 'system' THEN
    NEW.actor_type := 'system';
    NEW.actor_id := NULL;
    v_instance := NULLIF(pg_catalog.current_setting('application_name', true), '');
    IF v_instance IS NOT NULL AND (NEW.detail IS NULL OR pg_catalog.jsonb_typeof(NEW.detail) = 'object') THEN
      NEW.detail := COALESCE(NEW.detail, '{}'::jsonb) || pg_catalog.jsonb_build_object('workerInstance', v_instance);
    END IF;
  ELSIF v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    RAISE EXCEPTION 'AUDIT_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  NEW.occurred_at := pg_catalog.now();
  RETURN NEW;
END $$;

-- EXECUTE matrix: the trigger's function is callable by nobody (CREATE OR REPLACE keeps the trigger and the grants;
-- stated again).
REVOKE ALL ON FUNCTION crove_kernel.audit_event_stamp() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
