-- Follow-ups to the org-less self revoke (issue #196, from the #184 review). Idempotent.
--
-- 1. A user's own revoke without an org ran through kernel.session.revoke in their oldest org, and the org-less
--    definer refused anyone with an org. When that org could not run it, the global self revoke was lost: an owner
--    had revoked this session in that org only (session_check refuses SESSION_REVOKED_IN_ORG), or the user was
--    removed from it mid-request (NOT_A_MEMBER). One org's owner could thus keep a member's session alive in their
--    other orgs and in org-less calls until it expired, against ADR-0028 section 4 (a self revoke is global).
--    The kernel now tries each of the user's orgs in turn, and session_revoke_orgless refuses a user only while
--    one of their active orgs could still run the audited command: an org where the caller's session is revoked
--    for that org no longer counts. Nothing else changes from 20261017130000_crove_kernel_session_revoke_orgless.sql.
-- 2. A revoked session also keeps who revoked it and why: auth_session_keep_revoked refuses to change revoked_by
--    or reason once set (the definers already keep them with coalesce; now the trigger enforces it). Applies to
--    auth_session and auth_session_org, which share the trigger function.

CREATE OR REPLACE FUNCTION crove_kernel.auth_session_keep_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status = 'revoked' AND (
       NEW.status <> 'revoked'
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR (OLD.revoked_by IS NOT NULL AND NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)
       OR (OLD.reason IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason)) THEN
    RAISE EXCEPTION 'session % stays revoked', OLD.session_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

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
  -- An active org (as my_orgs lists them) where the caller's session still works: the revoke goes through
  -- kernel.session.revoke there, audited. An org whose owner revoked this session for that org cannot run it.
  IF EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.tenant t ON t.org_id = m.org_id
    WHERE m.user_id = p_user_id AND t.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM crove_kernel.auth_session_org o
        WHERE o.org_id = m.org_id AND o.user_id = p_user_id AND o.session_id = p_current_session AND o.status = 'revoked'
      )
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
