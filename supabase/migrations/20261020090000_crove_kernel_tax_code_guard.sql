-- Crove kernel (issue #430, review of #427): the org's tax code decides which invoices are read as sales (#313), so
-- only kernel.org.set_tax_code (owners and admins, audited) changes it. Before, any writer of crove_kernel.tenant could
-- change it: the table grants UPDATE to crove_tenant for every column, so a member's raw statement in its own org, or
-- any other code path, would have changed it without the role check or the audit row. Now, for every writer:
-- - tenant_tax_code_guard (BEFORE INSERT OR UPDATE OF tax_code): a change of the tax code is refused
--   (TAX_CODE_FORBIDDEN, 42501) unless the sealed context is a user who is an owner or admin of the org. A row is
--   inserted without one (org creation sets none). Staff (a superuser, or a role that can act as the table's owner, as
--   in tenant_status_guard) may make any change, so a later migration or a support fix is not locked out.
-- - tenant_tax_code_requires_audit (deferred to commit): a change made by anyone but staff commits only together with
--   the 'ok' audit row of kernel.org.set_tax_code that execute() writes in the same transaction (occurred_at defaults
--   to now(), the transaction start), by an owner or admin of the org, naming the new value. As
--   tenant_offboarding_requires_audit does for the status.
-- Agents never get here: agent_write_guard refuses every tenant row an agent context writes. Idempotent.
SET LOCAL lock_timeout = '2s';

-- Whether the session is staff: a superuser or a role that can act as the owner of the table (the migration runner).
-- MEMBER is not enough (a CREATEROLE runner holds ADMIN on the roles it created), so the test is USAGE, as in
-- tenant_status_guard. SESSION_USER is the login role whatever definer runs the statement.
CREATE OR REPLACE FUNCTION crove_kernel.tenant_tax_code_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_user uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.tax_code IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.tax_code IS NOT DISTINCT FROM OLD.tax_code THEN
    RETURN NEW;
  END IF;
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NEW;
  END IF;
  v_user := crove_kernel.ctx_user_id();
  IF TG_OP = 'INSERT'
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'TAX_CODE_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only kernel.org.set_tax_code, run by an owner or admin of the org, changes its tax code';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_tax_code_guard ON crove_kernel.tenant;
CREATE TRIGGER tenant_tax_code_guard BEFORE INSERT OR UPDATE OF tax_code ON crove_kernel.tenant
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.tenant_tax_code_guard();

CREATE OR REPLACE FUNCTION crove_kernel.tenant_tax_code_requires_audit()
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
    JOIN crove_kernel.tenant_member m ON m.org_id = a.org_id AND m.user_id = a.actor_id AND m.role IN ('owner', 'admin')
    WHERE a.org_id = NEW.org_id
      AND a.command = 'kernel.org.set_tax_code'
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.occurred_at = pg_catalog.now()
      AND a.detail ->> 'taxCode' IS NOT DISTINCT FROM NEW.tax_code
  ) THEN
    RAISE EXCEPTION 'TAX_CODE_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tenant_tax_code_requires_audit ON crove_kernel.tenant;
CREATE CONSTRAINT TRIGGER tenant_tax_code_requires_audit
  AFTER UPDATE OF tax_code ON crove_kernel.tenant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.tax_code IS DISTINCT FROM NEW.tax_code)
  EXECUTE FUNCTION crove_kernel.tenant_tax_code_requires_audit();

-- EXECUTE matrix: the triggers' functions are callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.tenant_tax_code_guard(), crove_kernel.tenant_tax_code_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
