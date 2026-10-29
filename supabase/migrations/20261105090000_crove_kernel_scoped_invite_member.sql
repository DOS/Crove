-- A scoped invite accepted by someone who is already a member of the org (#1459, a #1281 follow-up). Until now
-- invite_accept kept their membership and access and ignored the invite's legal entities (the audit row said
-- scope_applied: false), so neither the invitee nor the owner learned that the scope did nothing. It is refused now:
-- INVITE_SCOPE_ALREADY_MEMBER (409), nothing changes, and the invite stays pending, for the owner to revoke or for an
-- owner to grant the entities to the member another way. An unscoped invite of an existing member is accepted as
-- before (they keep their role).
--
-- Restated from 20261104040000_crove_kernel_membership_lock.sql with that one check, before anything is written.
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
