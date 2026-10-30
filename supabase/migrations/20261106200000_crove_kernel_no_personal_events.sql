-- Crove kernel (issue #1949, ADR-0017 section 1): personal values leave two rows that outlive every erasure. Idempotent;
-- applied files stay untouched.
--
-- crove_kernel.task.pending_draft  The draft an agent's kernel.task.propose built (a party's name, tax code, address,
--     email and phone), which waits on its task until the worker creates the proposal from it and takes it off. The
--     kernel.agent.proposal_requested event now carries the draft's id, not the draft: an event is append-only, and the
--     outbox archive keeps payloads as plain JSON for 400 days. Agents write it only on a task they hold the lease of
--     (task_before_update), like the lease columns.
-- crove_kernel.user_account.status_reason  The operator's reason for blocking or unblocking an account. The audit note
--     in each org (kernel.user.status_note) keeps a code instead of the text: an audit row is append-only and anchored
--     in the WORM stream. A control-plane column: no tenant role reads it.
-- crove_kernel.user_set_disabled(p_ref, p_disabled, p_reason)  The function of 20261026070000 with the reason stored on
--     the account, under the same row lock. The two-argument function stays as it is (its own tests pin it); the
--     operator's command calls this one. Only the worker login role may execute it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.task ADD COLUMN IF NOT EXISTS pending_draft jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'task_pending_draft_shape' AND conrelid = 'crove_kernel.task'::regclass) THEN
    -- The command holds the payload to 64 KiB of compact JSON (MAX_DRAFT_PAYLOAD_BYTES); jsonb's text form adds spaces,
    -- so this is a backstop at four times that.
    ALTER TABLE crove_kernel.task ADD CONSTRAINT task_pending_draft_shape
      CHECK (pending_draft IS NULL OR (pg_catalog.jsonb_typeof(pending_draft) = 'object' AND pg_catalog.octet_length(pending_draft::text) <= 262144));
  END IF;
END $$;

ALTER TABLE crove_kernel.user_account ADD COLUMN IF NOT EXISTS status_reason text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'user_account_status_reason_length' AND conrelid = 'crove_kernel.user_account'::regclass) THEN
    ALTER TABLE crove_kernel.user_account ADD CONSTRAINT user_account_status_reason_length
      CHECK (status_reason IS NULL OR pg_catalog.length(status_reason) BETWEEN 1 AND 500);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crove_kernel.user_set_disabled(p_ref text, p_disabled boolean, p_reason text)
RETURNS TABLE (outcome text, user_id uuid, changed boolean, disabled_at timestamptz, org_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ref text := pg_catalog.btrim(coalesce(p_ref, ''));
  v_ids uuid[];
  v_id uuid;
  v_before timestamptz;
  v_after timestamptz;
BEGIN
  -- Also refuses a definer owner or another role reached through a mistaken grant: only the worker login.
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'USER_STATUS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_disabled IS NULL OR v_ref = '' OR pg_catalog.length(v_ref) > 320
     OR pg_catalog.length(pg_catalog.btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500 THEN
    outcome := 'invalid';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_ids := ARRAY(SELECT u.id FROM crove_kernel.user_account u WHERE u.id = v_ref::uuid);
  ELSE
    v_ids := ARRAY(SELECT u.id FROM crove_kernel.user_account u WHERE pg_catalog.lower(u.email) = pg_catalog.lower(v_ref) ORDER BY u.id);
  END IF;
  IF pg_catalog.cardinality(v_ids) <> 1 THEN
    outcome := CASE WHEN pg_catalog.cardinality(v_ids) = 0 THEN 'not_found' ELSE 'ambiguous' END;
    RETURN NEXT;
    RETURN;
  END IF;
  v_id := v_ids[1];

  SELECT u.disabled_at INTO v_before FROM crove_kernel.user_account u WHERE u.id = v_id FOR UPDATE;
  IF p_disabled AND v_before IS NULL THEN
    UPDATE crove_kernel.user_account u SET disabled_at = pg_catalog.now() WHERE u.id = v_id RETURNING u.disabled_at INTO v_after;
  ELSIF NOT p_disabled AND v_before IS NOT NULL THEN
    UPDATE crove_kernel.user_account u SET disabled_at = NULL WHERE u.id = v_id;
    v_after := NULL;
  ELSE
    v_after := v_before;
  END IF;
  -- The operator's words, on the account (mutable), never in an org's audit row (#1949).
  UPDATE crove_kernel.user_account u SET status_reason = pg_catalog.btrim(p_reason) WHERE u.id = v_id;

  outcome := 'ok';
  user_id := v_id;
  changed := v_after IS DISTINCT FROM v_before;
  disabled_at := v_after;
  org_ids := ARRAY(SELECT m.org_id FROM crove_kernel.tenant_member m WHERE m.user_id = v_id ORDER BY m.org_id);
  RETURN NEXT;
END $$;

-- EXECUTE matrix: only the worker login role.
REVOKE ALL ON FUNCTION crove_kernel.user_set_disabled(text, boolean, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.user_set_disabled(text, boolean, text) TO crove_worker;
