-- An invite addressed to someone who was removed from the org after it was made adds nobody (#1880). Removing a member
-- revokes the org's pending invites addressed to their account's email (kernel.member.remove); this is the backstop for
-- the invites that misses: those of members removed before it did, and one addressed to an email the account takes
-- after the removal. The acceptance is refused (INVITE_REVOKED) when the user's removal from the org, recorded by its
-- audit row (outcome ok, target the user, indexed by audit_event_member_remove_idx), is not older than the invite. An
-- invite made after the removal, to invite them back, works as any other.
--
-- Restated from 20261105090000_crove_kernel_scoped_invite_member.sql with that one check, right after the membership
-- insert: in the read committed transaction of a command, a removal that the insert waited for has committed by then,
-- and the check's own snapshot sees its audit row.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.invite_accept(p_user_id uuid, p_token text, p_upstream boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_invite crove_kernel.member_invite := crove_kernel.invite_for_user(p_user_id, p_token, true, p_upstream);
  v_joined boolean := false;
BEGIN
  -- A purge of this user's items in the org (crove_notes.member_items_purge) either finished before this, or waits for
  -- it and then sees the membership.
  PERFORM crove_kernel.membership_lock(v_invite.org_id, p_user_id);
  INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
  VALUES (v_invite.org_id, p_user_id, v_invite.role)
  ON CONFLICT (org_id, user_id) DO NOTHING
  RETURNING true INTO v_joined;
  -- Removed from the org after the invite was made: it was revoked with the removal, or would have been (#1880).
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_invite.org_id AND a.command = 'kernel.member.remove' AND a.outcome = 'ok'
      AND a.target_id = p_user_id AND a.occurred_at >= v_invite.created_at
  ) THEN
    RAISE EXCEPTION 'INVITE_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.legal_entity_ids IS NOT NULL AND NOT COALESCE(v_joined, false) THEN
    -- Already a member: a scope would change their access, which an invite never does. Nothing was written (the
    -- insert did nothing), and the exception rolls the statement back all the same.
    RAISE EXCEPTION 'INVITE_SCOPE_ALREADY_MEMBER' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.legal_entity_ids IS NOT NULL THEN
    -- invite_for_user holds the inviter's membership row FOR SHARE: a demotion that committed first is seen here.
    IF NOT EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = v_invite.org_id AND m.user_id = v_invite.invited_by AND m.role = 'owner')
       OR (SELECT pg_catalog.count(*) FROM crove_kernel.legal_entity e
           WHERE e.org_id = v_invite.org_id AND e.id = ANY (v_invite.legal_entity_ids)) <> pg_catalog.cardinality(v_invite.legal_entity_ids) THEN
      RAISE EXCEPTION 'INVITE_SCOPE_STALE' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
    SELECT v_invite.org_id, p_user_id, 'external_accountant', x, v_invite.invited_by
    FROM pg_catalog.unnest(v_invite.legal_entity_ids) x
    ON CONFLICT ON CONSTRAINT role_assignment_uq DO NOTHING;
  END IF;
  UPDATE crove_kernel.member_invite
  SET status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = p_user_id
  WHERE org_id = v_invite.org_id AND id = v_invite.id;
  RETURN v_invite.org_id;
END $$;
-- EXECUTE matrix (restated): only the API login role accepts invites.
REVOKE ALL ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean) FROM PUBLIC, crove_tenant, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.invite_accept(uuid, text, boolean) TO crove_app;
