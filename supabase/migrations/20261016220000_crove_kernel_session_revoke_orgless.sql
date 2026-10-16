-- A user's own session revoke without an org (issue #184, ADR-0028 section 4). Idempotent.
--
-- sessions.revoke ran only inside an org (header x-crove-org), so a user with no org (onboarding) could not revoke
-- their own session on sign-out, and the access token kept working until it expired. A self revoke is global
-- (session_revoke's self branch), so the org only chose where the audit row lands. The kernel now routes a self
-- revoke sent without an org:
--   * a user who belongs to an active org: the usual kernel.session.revoke command in their oldest active org,
--     unchanged (the same session_revoke definer, audit row, activity and outbox event for the upstream sign-out);
--   * a user who belongs to no active org: this definer, in the org-less request transaction (Runtime.forUser),
--     right after the session check. There is no org to hold an audit row or an outbox event. The auth_session row
--     records who revoked the session, when and why, and stays revoked (keep_revoked trigger). No upstream sign-out
--     is queued: the SPA signs its own session out of Supabase Auth right after, and the revoked record already
--     refuses the session in Crove (ADR-0028: correctness does not depend on the upstream call).
--
-- Only the user themself, and only while they belong to no active org:
--   * p_user_id is the caller: the kernel passes the verified token's user, as for my_orgs and invite_accept. The
--     call is also bound to a live session of that user: p_current_session (the request's session id) must be an
--     active auth_session row of p_user_id, which this transaction's session check has just recorded or confirmed.
--   * ORG_REQUIRED (42501) when the user belongs to an active org: that revoke goes through the audited command.
--   * NOT_ORGLESS (42501) inside an org context: this definer never runs in a tenant transaction.
--   * SESSION_INVALID (28000) for an unknown user or a caller session that is not active; USER_DISABLED (42501).
-- Nobody revokes another user's sessions here, org owners included: they revoke in their org.

CREATE OR REPLACE FUNCTION crove_kernel.session_revoke_orgless(
  p_user_id uuid, p_current_session uuid, p_session_id uuid, p_reason text)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_subject text;
  v_disabled timestamptz;
  v_targets uuid[];
  v_id uuid;
BEGIN
  IF crove_kernel.ctx_user_id() IS NOT NULL OR crove_kernel.ctx_org_id() IS NOT NULL THEN
    RAISE EXCEPTION 'NOT_ORGLESS' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_current_session IS NULL THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  SELECT u.subject, u.disabled_at INTO v_subject, v_disabled FROM crove_kernel.user_account u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'USER_DISABLED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.auth_session s
    WHERE s.user_id = p_user_id AND s.session_id = p_current_session AND s.status = 'active'
  ) THEN
    RAISE EXCEPTION 'SESSION_INVALID' USING ERRCODE = '28000';
  END IF;
  -- The same orgs my_orgs lists: anyone who has one revokes through kernel.session.revoke in it, audited there.
  IF EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.tenant t ON t.org_id = m.org_id
    WHERE m.user_id = p_user_id AND t.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ORG_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_session_id IS NOT NULL THEN
    v_targets := ARRAY[p_session_id];
  ELSE
    -- Every session Crove has seen and, when Supabase Auth's sessions are readable, every upstream one.
    v_targets := ARRAY(SELECT s.session_id FROM crove_kernel.auth_session s WHERE s.user_id = p_user_id AND s.status = 'active');
    IF v_subject ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND crove_kernel.auth_grants_ready() THEN
      v_targets := v_targets || ARRAY(SELECT crove_kernel.auth_user_sessions(v_subject::uuid));
    END IF;
  END IF;
  FOR v_id IN SELECT DISTINCT t FROM pg_catalog.unnest(v_targets) t LOOP
    INSERT INTO crove_kernel.auth_session AS s (user_id, session_id, status, revoked_at, revoked_by, reason)
    VALUES (p_user_id, v_id, 'revoked', pg_catalog.now(), p_user_id, p_reason)
    ON CONFLICT (user_id, session_id) DO UPDATE
      SET status = 'revoked',
          revoked_at = coalesce(s.revoked_at, excluded.revoked_at),
          revoked_by = coalesce(s.revoked_by, excluded.revoked_by),
          reason = coalesce(s.reason, excluded.reason);
    RETURN NEXT v_id;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.session_revoke_orgless(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.session_revoke_orgless(uuid, uuid, uuid, text) TO crove_app;
