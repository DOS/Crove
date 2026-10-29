-- Crove kernel (issue #1922, from the reviews of #1921): the chief accountant keep guard no longer waits for every
-- command of the org in flight. Idempotent; applied files stay untouched.
--
-- crove_kernel.chief_accountant_keep_guard (20261102020000_crove_kernel_approval_presets.sql, the only definition)
-- serialized on the org with the tenant row FOR UPDATE. That mode also waits for FOR KEY SHARE, which every command of
-- the org holds on that row from its first insert (the idempotency row's foreign key), so a revoke, demotion to viewer
-- or removal of a chief accountant in an org on the accountant preset waited for every such command. With a command
-- that then waits on the member rows the revoke holds, that is a deadlock:
--   - a period lock or unlock (#1921) locks its caller's member row FOR SHARE after its idempotency row;
--   - the role commands lock the actor's and the member's rows FOR UPDATE, kernel.member.change_role and remove every
--     owner's row too, so an owner who locks or unlocks a month while another owner (or they themself, in another tab)
--     revokes or demotes a chief accountant is caught either way.
-- One side was refused as a deadlock (RETRY). The guard now takes the row FOR NO KEY UPDATE, which KEY SHARE does not
-- conflict with. What it serializes stays serialized: two guards still wait for each other (NO KEY UPDATE conflicts
-- with itself), and a change of the org's preset is an UPDATE of the row, which takes the same mode. A command in
-- flight that only references the org cannot remove a chief accountant without the guard, so the guard has no reason
-- to wait for it. Copied with that change; the triggers are unchanged.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.chief_accountant_keep_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := OLD.org_id;
  v_staff boolean;
  v_only boolean;
BEGIN
  SELECT p.ledger_chief_accountant_only INTO v_only
  FROM crove_kernel.tenant t JOIN crove_kernel.approval_preset p ON p.key = t.approval_preset
  WHERE t.org_id = v_org AND t.status = 'active';
  IF NOT COALESCE(v_only, false) THEN
    RETURN NULL;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NULL;
  END IF;
  -- Serialize on the org, then decide on what has committed since (each statement takes a new snapshot). FOR NO KEY
  -- UPDATE (#1922): it waits for another guard and for a change of the preset (an UPDATE of the tenant row), not for
  -- the commands in flight that only reference the org (their rows' foreign keys hold it FOR KEY SHARE).
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
