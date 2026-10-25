-- Crove kernel (issue #1402, plan §4.7): the org's approval policy preset, kept as data rows, and the policy version
-- the approval audit row records. Idempotent; applied files stay untouched.
--
-- crove_kernel.approval_preset  the presets of plan §4.7: global data rows, like crove_kernel.role.
--                               founder     the ledger's proposals are approved by owners and admins, and by members
--                                           an owner made chief accountant (finance.proposal.approve, #1279);
--                               accountant  P09: only a human holding finance.proposal.approve (the chief accountant
--                                           role) approves them; owners and admins approve only when they hold it.
-- crove_kernel.tenant           approval_preset (default founder) and approval_policy_version, which starts at 1 and
--                               grows by one on every change, so an approval audit row names the policy it ran under.
--
-- Writes: only an owner changes the preset, through the audited R3 command kernel.org.set_approval_preset.
-- tenant_approval_policy_guard refuses any other change of the two columns (a user who is not an owner of the org, a
-- system or agent context, a version that does not grow by exactly one with the change), and
-- tenant_approval_policy_requires_audit lets one commit only with that command's 'ok' audit row naming the new
-- preset and version, as tenant_tax_code_guard and tenant_tax_code_requires_audit do for the tax code. Staff (a
-- superuser, or a role that can act as the table's owner) may make any change, so a support fix is not locked out.
-- The default stays founder for every org, new or existing: switching orgs that keep books to accountant by default is
-- an owner decision (#1402).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.approval_preset (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  -- P09: the ledger's proposals are approved only by a human holding finance.proposal.approve.
  ledger_chief_accountant_only boolean NOT NULL
);

INSERT INTO crove_kernel.approval_preset (key, ledger_chief_accountant_only) VALUES
  ('founder', false),
  ('accountant', true)
ON CONFLICT (key) DO UPDATE SET ledger_chief_accountant_only = EXCLUDED.ledger_chief_accountant_only;

-- Catalog: everyone reads it, no runtime role writes it (migrations do), and no agent context either.
REVOKE ALL ON crove_kernel.approval_preset FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT ON crove_kernel.approval_preset TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.approval_preset');

ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS approval_preset text NOT NULL DEFAULT 'founder';
ALTER TABLE crove_kernel.tenant ADD COLUMN IF NOT EXISTS approval_policy_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant
    ADD CONSTRAINT tenant_approval_preset_fk FOREIGN KEY (approval_preset) REFERENCES crove_kernel.approval_preset (key);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE crove_kernel.tenant ADD CONSTRAINT tenant_approval_policy_version_check CHECK (approval_policy_version >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Whether the session is staff: a superuser or a role that can act as the owner of the table (the migration runner),
-- as in tenant_tax_code_guard.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_approval_policy_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_preset = 'founder' AND NEW.approval_policy_version = 1 THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.approval_preset IS NOT DISTINCT FROM OLD.approval_preset
        AND NEW.approval_policy_version IS NOT DISTINCT FROM OLD.approval_policy_version THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.approval_policy_version IS DISTINCT FROM OLD.approval_policy_version + 1
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
     ) THEN
    RAISE EXCEPTION 'APPROVAL_POLICY_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only kernel.org.set_approval_preset, run by an owner of the org, changes its approval policy';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_approval_policy_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_approval_policy_guard BEFORE INSERT OR UPDATE OF approval_preset, approval_policy_version ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_approval_policy_guard();

CREATE OR REPLACE FUNCTION crove_kernel.tenant_approval_policy_requires_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.actor_id AND m.role = 'owner'
    WHERE a.org_id = NEW.org_id
      AND a.command = 'kernel.org.set_approval_preset'
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.occurred_at = pg_catalog.now()
      AND a.detail ->> 'preset' IS NOT DISTINCT FROM NEW.approval_preset
      AND a.detail ->> 'version' IS NOT DISTINCT FROM NEW.approval_policy_version::text
  ) THEN
    RAISE EXCEPTION 'APPROVAL_POLICY_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_approval_policy_requires_audit ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_approval_policy_requires_audit
  AFTER UPDATE OF approval_preset, approval_policy_version ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.approval_preset IS DISTINCT FROM NEW.approval_preset
                     OR OLD.approval_policy_version IS DISTINCT FROM NEW.approval_policy_version)
  EXECUTE FUNCTION crove_kernel.tenant_approval_policy_requires_audit();

-- EXECUTE matrix: the triggers' functions are callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.tenant_approval_policy_guard(), crove_kernel.tenant_approval_policy_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Liveness under the accountant preset (P09): while an active org is on a preset that reserves the ledger to the chief
-- accountant, it keeps at least one member, not a viewer, holding finance.proposal.approve org-wide. Revoking that
-- assignment, removing that member or demoting them to viewer is refused (LAST_CHIEF_ACCOUNTANT, P0001) when it would
-- leave none; kernel.org.set_approval_preset refuses the switch itself without one. Each such change then locks the
-- tenant row, as the switch does, so two of them in one org (or one and a switch) run one at a time and the second sees
-- the first. A closed org
-- (offboarding, the purge) and staff are not held back. Proposals raised while no other approver existed are recovered
-- by rejecting and raising them again, or by resubmitting them once expired (kernel.proposal.resubmit): a new proposal
-- takes a new snapshot.
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
  -- Serialize on the org, then decide on what has committed since (each statement takes a new snapshot).
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR UPDATE;
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
DROP TRIGGER IF EXISTS chief_accountant_keep_guard ON crove_kernel.role_assignment;
CREATE TRIGGER chief_accountant_keep_guard AFTER DELETE ON crove_kernel.role_assignment
  FOR EACH ROW WHEN (OLD.legal_entity_id IS NULL) EXECUTE FUNCTION crove_kernel.chief_accountant_keep_guard();
DROP TRIGGER IF EXISTS chief_accountant_keep_guard_member ON crove_kernel.tenant_member;
CREATE TRIGGER chief_accountant_keep_guard_member AFTER DELETE ON crove_kernel.tenant_member
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.chief_accountant_keep_guard();
DROP TRIGGER IF EXISTS chief_accountant_keep_guard_viewer ON crove_kernel.tenant_member;
CREATE TRIGGER chief_accountant_keep_guard_viewer AFTER UPDATE OF role ON crove_kernel.tenant_member
  FOR EACH ROW WHEN (NEW.role = 'viewer' AND OLD.role <> 'viewer') EXECUTE FUNCTION crove_kernel.chief_accountant_keep_guard();

REVOKE ALL ON FUNCTION crove_kernel.chief_accountant_keep_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
