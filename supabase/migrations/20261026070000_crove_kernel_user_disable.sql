-- Disable and re-enable a user account from the operator's command (issue #985, ADR-0028 section 2: "user_account.
-- disabled_at, set by an audited staff command"). Idempotent; applied files stay untouched.
--
-- crove_kernel.user_set_disabled(p_ref, p_disabled)
--   p_ref is the account's id or its email (case-insensitive). outcome is 'invalid' for an empty or overlong ref,
--   'not_found', 'ambiguous' when two accounts share the email (the operator then names the id), else 'ok': under the
--   account's row lock it sets disabled_at to now() or clears it, and answers the account, whether anything changed
--   and the orgs the user belongs to, which the caller audits through execute() (one kernel.user.status_note per
--   org). The outcomes are answered, not raised, so the operator sees which one it was. A disabled account is
--   refused on its next request by session_check and the org-less checks (403 USER_DISABLED), which already read
--   disabled_at; this only gives the column an owner.
--   Only the worker login role may execute it: the `user-disable` and `user-enable` image roles run in the worker's
--   container, as `exports-rebind` does. No tenant or API role reaches it.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.user_set_disabled(p_ref text, p_disabled boolean)
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
  IF p_disabled IS NULL OR v_ref = '' OR pg_catalog.length(v_ref) > 320 THEN
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

  outcome := 'ok';
  user_id := v_id;
  changed := v_after IS DISTINCT FROM v_before;
  disabled_at := v_after;
  org_ids := ARRAY(SELECT m.org_id FROM crove_kernel.tenant_member m WHERE m.user_id = v_id ORDER BY m.org_id);
  RETURN NEXT;
END $$;

-- EXECUTE matrix: only the worker login role.
REVOKE ALL ON FUNCTION crove_kernel.user_set_disabled(text, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.user_set_disabled(text, boolean) TO crove_worker;
