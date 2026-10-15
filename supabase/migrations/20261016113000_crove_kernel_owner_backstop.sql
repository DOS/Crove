-- Database backstop for "an org keeps at least one owner" (issue #119, plan §7.3 item 2). Idempotent; applied
-- files stay untouched.
--
-- Before: only the commands kept an owner. kernel.member.change_role and kernel.member.remove lock the org's owner
-- rows with the actor and the target and refuse LAST_OWNER, but nothing in the database stopped another write path
-- (a future command without those locks, or a manual statement) from leaving an org with no owner.
--
-- After: a deferred constraint trigger on tenant_member checks, at commit, every org whose owner row was deleted,
-- demoted or moved to another org in the transaction, and refuses the commit (LAST_OWNER, P0001) when that org would
-- have no owner left. It holds for every DELETE and UPDATE, from any role, the database owner included (only a
-- table owner disabling the trigger or a superuser in replica mode bypasses it; no Crove role may TRUNCATE).
--   - Concurrency: the check first takes a transaction-level advisory lock on the org, so two transactions that each
--     remove a different owner check one after the other; the second runs its count after the first committed (READ
--     COMMITTED takes a new snapshot per statement, the level every Crove transaction uses) and sees zero owners.
--     The lock is taken only at commit and only when an owner row changed, so it never meets the commands' row locks
--     while they are still deciding.
--   - No exception for closing or deleting an org: no path does either today. No command closes an org (status
--     'closed' exists only in the schema), and a tenant row cannot be deleted, since its ON DELETE CASCADE reaches
--     audit_event, which is append-only, and every tenant commits with its kernel.org.create audit row. Offboarding
--     (§7.9) decides how the backstop treats a closed or purged org when it is built; until then it fails closed.
--   - Org creation (create_or_replay_org) and invite acceptance (invite_accept) only insert memberships, so they never
--     fire it; an invite never makes an owner.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.tenant_member_keeps_owner()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Serializes the checks of one org: whoever checks second counts after the first committed.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.tenant_member.owner:' || OLD.org_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = OLD.org_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'LAST_OWNER' USING ERRCODE = 'P0001',
      DETAIL = 'an org keeps at least one owner';
  END IF;
  RETURN NULL;
END $$;

-- Two triggers because a DELETE trigger's WHEN cannot read NEW. Only changes that take an owner away from an org fire.
DROP TRIGGER IF EXISTS tenant_member_keeps_owner_on_delete ON crove_kernel.tenant_member;
CREATE CONSTRAINT TRIGGER tenant_member_keeps_owner_on_delete
  AFTER DELETE ON crove_kernel.tenant_member
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.role = 'owner') EXECUTE FUNCTION crove_kernel.tenant_member_keeps_owner();

DROP TRIGGER IF EXISTS tenant_member_keeps_owner_on_update ON crove_kernel.tenant_member;
CREATE CONSTRAINT TRIGGER tenant_member_keeps_owner_on_update
  AFTER UPDATE ON crove_kernel.tenant_member
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.org_id <> OLD.org_id))
  EXECUTE FUNCTION crove_kernel.tenant_member_keeps_owner();

-- EXECUTE matrix: the trigger function is callable by nobody (it runs only as the trigger).
REVOKE ALL ON FUNCTION crove_kernel.tenant_member_keeps_owner()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
