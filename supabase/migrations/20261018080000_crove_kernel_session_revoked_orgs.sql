-- The orgs where one session of a user was revoked by the org's owner (issue #247, ADR-0028 section 4). Idempotent.
--
-- An owner's revoke of a member's session holds in that org only (auth_session_org), and session_check refuses the
-- session there with SESSION_REVOKED_IN_ORG. me.get listed every org of the user (my_orgs), so the SPA kept
-- sending the user back into an org the session can no longer enter. me.get now leaves these orgs out for the
-- session that asks. Membership is unchanged; enter_context still decides on every request.
--
-- Returns org ids only, for (p_user_id, p_session_id) as the kernel passes them from the verified token (the same
-- trust as my_orgs). Only the API login role may call it.

CREATE OR REPLACE FUNCTION crove_kernel.session_revoked_orgs(p_user_id uuid, p_session_id uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.org_id
  FROM crove_kernel.auth_session_org o
  WHERE o.user_id = p_user_id AND o.session_id = p_session_id AND o.status = 'revoked'
$$;

REVOKE ALL ON FUNCTION crove_kernel.session_revoked_orgs(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_kernel.session_revoked_orgs(uuid, uuid) TO crove_app;
