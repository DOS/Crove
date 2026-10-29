-- Crove Notes: a former member's purge and their re-add serialize (issue #1722, ADR-0037 §4). Idempotent; applied files
-- stay untouched.
--
-- member_items_purge  redefined from its newest body (20261103230000_crove_notes_purge_guards.sql) with the same
--   signature, grants, checks and deletes, plus crove_kernel.membership_lock(org, user) before the membership check.
--   invite_accept takes the same lock before it inserts the membership (20261104040000_crove_kernel_membership_lock.sql),
--   so a re-add that commits while the purge runs can no longer slip between the purge's check and its deletes: the
--   purge waits for it, then sees the member and removes nothing.
-- former_members_due is unchanged: it only lists candidates, and each purge it leads to checks again under the lock.
-- Both read the 30-day delay from the member-removal audit rows through audit_event_member_remove_idx (#1757).
SET LOCAL lock_timeout = '2s';

-- Removes a former member's private notes and every to-do of theirs from the context's org, unless they are a member
-- again or were removed from it less than 30 days ago (NOTE_MEMBER_PURGE_DAYS; their latest kernel.member.remove in
-- the audit trail) (worker login, in the org's system context: notes.member_items.purge, 30 days after the removal or
-- from the daily sweep). Their shared notes stay with the org, and so do the tasks their handed-over to-dos became.
-- Holds the membership lock until the transaction ends, so a re-add waits or is seen. Returns how many it removed.
CREATE OR REPLACE FUNCTION crove_notes.member_items_purge(p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
  v_t bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'NOTES_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NOTES_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- A re-add of this user to the org (crove_kernel.invite_accept) either committed before this, and the check below
  -- sees it, or waits until this transaction ends.
  PERFORM crove_kernel.membership_lock(v_org, p_user);
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user) THEN
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_org AND a.occurred_at > pg_catalog.now() - interval '30 days'
      AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = p_user
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM crove_notes.note n WHERE n.org_id = v_org AND n.author_user_id = p_user AND n.visibility = 'private';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_notes.todo t WHERE t.org_id = v_org AND t.owner_user_id = p_user;
  GET DIAGNOSTICS v_t = ROW_COUNT;
  RETURN v_n + v_t;
END $$;
REVOKE ALL ON FUNCTION crove_notes.member_items_purge(uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.member_items_purge(uuid) TO crove_worker;
