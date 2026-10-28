-- A purge of a former member's items and a re-add of that member serialize (issue #1722), and the member-removal audit
-- rows the purge delay reads are indexed (issue #1757). Idempotent; applied files stay untouched.
--
-- crove_kernel.membership_lock(org, user)  takes a transaction-level advisory lock on the membership of p_user in
--   p_org. Every path that makes someone a member of an existing org takes it before its insert (invite_accept, the
--   only one: create_or_replay_org makes the first owner of a new org, which nobody can have left yet), and so does a
--   definer that removes a former member's items before it checks the membership (crove_notes.member_items_purge, in
--   the next file). Without it, a re-add that committed between the purge's membership check and its deletes still lost
--   the member's private notes. With it, whichever comes second waits: a purge that waited sees the new membership
--   (each statement of a definer reads anew at READ COMMITTED) and removes nothing; a re-add that waited joins after
--   the purge, as if it had come a moment later. Callable by nobody but the definers' owner.
-- invite_accept  restated from 20261101231000_crove_kernel_scoped_invites.sql (the newest body on main), with the lock
--   taken after invite_for_user's row locks and before the membership insert; nothing else changes.
-- audit_event_member_remove_idx  the successful kernel.member.remove rows by org, target and time, which
--   member_items_purge and former_members_due read for the 30-day delay (20261103230000_crove_notes_purge_guards.sql).
--   Without it each call scanned every audit row of the org from the last 30 days. audit_event is a hot table, so the
--   index is built in the lock-retry block (plan §5.5); the build itself holds the table's SHARE lock until it ends.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.membership_lock(p_org uuid, p_user uuid)
RETURNS void LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.membership:' || p_org::text || ':' || p_user::text, 0))
$$;
REVOKE ALL ON FUNCTION crove_kernel.membership_lock(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Restated from 20261101231000_crove_kernel_scoped_invites.sql with the membership lock.
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
  IF v_invite.legal_entity_ids IS NOT NULL AND COALESCE(v_joined, false) THEN
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

-- A hot table: the index is created in the lock-retry block (plan §5.5).
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    CREATE INDEX IF NOT EXISTS audit_event_member_remove_idx ON crove_kernel.audit_event (org_id, target_id, occurred_at DESC)
      WHERE command = 'kernel.member.remove' AND outcome = 'ok';
    EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;
