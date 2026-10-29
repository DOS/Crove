-- Crove kernel (issue #1933, from the review of #1931): the chief accountant keep guard locks the org before it reads
-- the preset. Idempotent; applied files stay untouched.
--
-- crove_kernel.chief_accountant_keep_guard (as 20261106180000 left it) first read the org's preset without a lock and
-- returned at once while it was founder. A switch to the accountant preset (kernel.org.set_approval_preset, the tenant
-- row FOR UPDATE, then a count of the chief accountants) was serialized with a member change only through the change's
-- idempotency row, which holds the tenant row FOR KEY SHARE. A change made without an idempotency key (runtime.execute
-- called without one, by a tool or an internal caller) could interleave:
--   1. the change deletes the last chief accountant; its guard reads founder and returns, holding nothing on the org;
--   2. the switch locks the tenant row, still counts the holder (the delete is not committed) and commits;
--   3. the change commits: the org is on the accountant preset with no chief accountant.
-- The guard now takes its lock before the first read of the preset, whatever the preset is, and reads it once, under
-- the lock: a switch in flight makes it wait, and it then sees the accountant preset and refuses the change; a switch
-- after it waits for it, and then counts no holder (NO_CHIEF_ACCOUNTANT). The lock is still FOR NO KEY UPDATE (#1922):
-- it does not wait for the commands in flight that only reference the org (FOR KEY SHARE), so the period lock and
-- unlock of #1921 do not wait on it. Staff writes are still let through first, without a lock. What this adds is a
-- short wait between two member changes of one org, or a member change and an UPDATE of its tenant row, on the
-- founder preset as well; no command updates the tenant row and then changes a member in one transaction. Copied with
-- that change; the triggers are unchanged.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.chief_accountant_keep_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := OLD.org_id;
  v_staff boolean;
  v_only boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NULL;
  END IF;
  -- Serialize on the org first, then decide on what has committed since (each statement takes a new snapshot): the
  -- preset is never read before the lock (#1933). FOR NO KEY UPDATE (#1922): it waits for another guard and for a change
  -- of the preset (an UPDATE of the tenant row), not for the commands in flight that only reference the org (their
  -- rows' foreign keys hold it FOR KEY SHARE).
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR NO KEY UPDATE;
  SELECT p.ledger_chief_accountant_only INTO v_only
  FROM crove_kernel.tenant t JOIN crove_kernel.approval_preset p ON p.key = t.approval_preset
  WHERE t.org_id = v_org AND t.status = 'active';
  IF COALESCE(v_only, false) AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a
    JOIN crove_kernel.role_permission p ON p.role_key = a.role_key AND p.permission = 'finance.proposal.approve'
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.user_id AND m.role <> 'viewer'
    WHERE a.org_id = v_org AND a.legal_entity_id IS NULL
  ) THEN
    RAISE EXCEPTION 'LAST_CHIEF_ACCOUNTANT' USING ERRCODE = 'P0001',
      DETAIL = 'the accountant approval preset needs a chief accountant; switch the preset first';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.chief_accountant_keep_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
