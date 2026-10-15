-- "Revoke all" signs out globally from a session that is still alive upstream (issue #163). Idempotent.
--
-- Supabase Auth's global sign-out takes one session's token and answers 403 session_not_found once that session is
-- gone, leaving the user's other sessions alive. session_revoke used to give sign_out = 'global' to whichever
-- target came first, which could be the caller's own session; the web app signs that session out locally right
-- after "revoke everywhere", so the worker's global sign-out then failed and the other devices kept their refresh
-- tokens.
--
-- p_current_session is the caller's own session (the request's session_id). The global sign-out now goes to an owned
-- session other than it, the most recently seen one first. When the caller's session is the user's only owned
-- session, that session gets a local sign-out instead: nothing else is left to sign out, and a local sign-out of a
-- session already gone counts as done. It only steers which of the user's own sessions carries the sign-out, so a
-- wrong value changes nothing else. Everything else is unchanged from 20261015090000_crove_kernel_auth_sessions.sql.

DROP FUNCTION IF EXISTS crove_kernel.session_revoke(uuid, uuid, text);

CREATE OR REPLACE FUNCTION crove_kernel.session_revoke(
  p_user_id uuid, p_session_id uuid, p_reason text, p_current_session uuid DEFAULT NULL)
RETURNS TABLE (revoked_session uuid, auth_subject text, sign_out text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := crove_kernel.ctx_user_id();
  v_org uuid := crove_kernel.ctx_org_id();
  v_subject text;
  v_targets uuid[];
  v_owned uuid[];
  v_global uuid;
  v_id uuid;
BEGIN
  IF NOT crove_kernel.session_manage_check(p_user_id) THEN
    IF p_session_id IS NOT NULL THEN
      v_targets := ARRAY[p_session_id];
    ELSE
      SELECT coalesce(pg_catalog.array_agg(o.session_id), '{}') INTO v_targets
      FROM crove_kernel.auth_session_org o WHERE o.org_id = v_org AND o.user_id = p_user_id AND o.status = 'active';
    END IF;
    FOR v_id IN SELECT DISTINCT t FROM pg_catalog.unnest(v_targets) t LOOP
      INSERT INTO crove_kernel.auth_session_org AS o (org_id, user_id, session_id, status, revoked_at, revoked_by, reason)
      VALUES (v_org, p_user_id, v_id, 'revoked', pg_catalog.now(), v_actor, p_reason)
      ON CONFLICT (org_id, user_id, session_id) DO UPDATE
        SET status = 'revoked',
            revoked_at = coalesce(o.revoked_at, excluded.revoked_at),
            revoked_by = coalesce(o.revoked_by, excluded.revoked_by),
            reason = coalesce(o.reason, excluded.reason);
      revoked_session := v_id;
      auth_subject := NULL;
      sign_out := NULL;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  SELECT u.subject INTO v_subject FROM crove_kernel.user_account u WHERE u.id = p_user_id;
  IF v_subject ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND crove_kernel.auth_grants_ready() THEN
    v_owned := ARRAY(SELECT crove_kernel.auth_user_sessions(v_subject::uuid));
  ELSE
    v_owned := ARRAY(SELECT s.session_id FROM crove_kernel.auth_session s WHERE s.user_id = p_user_id AND s.status = 'active');
  END IF;
  IF p_session_id IS NOT NULL THEN
    v_targets := ARRAY[p_session_id];
  ELSE
    v_targets := ARRAY(SELECT s.session_id FROM crove_kernel.auth_session s WHERE s.user_id = p_user_id AND s.status = 'active')
      || v_owned;
    -- The session that carries the global sign-out: not the caller's own while another owned session exists.
    SELECT t INTO v_global
    FROM pg_catalog.unnest(v_owned) t
    LEFT JOIN crove_kernel.auth_session s ON s.user_id = p_user_id AND s.session_id = t
    ORDER BY (t IS NOT DISTINCT FROM p_current_session), s.last_seen_at DESC NULLS LAST, t
    LIMIT 1;
  END IF;
  FOR v_id IN SELECT DISTINCT t FROM pg_catalog.unnest(v_targets) t LOOP
    INSERT INTO crove_kernel.auth_session AS s (user_id, session_id, status, revoked_at, revoked_by, reason)
    VALUES (p_user_id, v_id, 'revoked', pg_catalog.now(), v_actor, p_reason)
    ON CONFLICT (user_id, session_id) DO UPDATE
      SET status = 'revoked',
          revoked_at = coalesce(s.revoked_at, excluded.revoked_at),
          revoked_by = coalesce(s.revoked_by, excluded.revoked_by),
          reason = coalesce(s.reason, excluded.reason);
    revoked_session := v_id;
    auth_subject := v_subject;
    sign_out := CASE
      WHEN NOT (v_id = ANY (v_owned)) THEN NULL
      WHEN p_session_id IS NOT NULL THEN 'local'
      WHEN v_id IS DISTINCT FROM v_global THEN NULL
      WHEN v_id IS NOT DISTINCT FROM p_current_session THEN 'local'
      ELSE 'global'
    END;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.session_revoke(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.session_revoke(uuid, uuid, text, uuid) TO crove_app;
