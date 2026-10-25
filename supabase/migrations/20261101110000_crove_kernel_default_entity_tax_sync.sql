-- Crove kernel (issue #1316, from the review of #1292): the org's default legal entity follows the org's tax code
-- whoever changes it. 20261030001000_crove_kernel_legal_entity.sql made the default entity's tax code the org's and
-- had only kernel.org.set_tax_code write both. Staff may also change crove_kernel.tenant.tax_code directly (a support
-- fix, the staff path of tenant_tax_code_guard, #430); that left the default entity on the old code, and
-- legal_entity_default_tax_code then refused every later write of the default entity, a rename included, because
-- kernel.legal_entity.update sets every editable column.
--
-- tenant_default_entity_tax_code (AFTER UPDATE OF tax_code on crove_kernel.tenant, only when the code changes) writes
-- the tenant's new code to the org's default entity, inside the same statement, for every writer:
-- - It runs only once tenant_tax_code_guard has let the change through and changes none of its rules: anyone but an
--   owner or admin of the org (or staff) is refused before it runs, and tenant_tax_code_requires_audit still requires
--   the audit row of kernel.org.set_tax_code from everyone but staff, at commit, so a refused change rolls this write
--   back with it.
-- - It writes one row, the default entity of the same org: its tax code and the update stamps (the context's user, or
--   none for staff), nothing else. It runs as the definer owner, so the writer's legal-entity scope cannot hide the
--   default entity from it. Agents never get here: agent_write_guard refuses every tenant row an agent writes.
-- - It cannot recurse: nothing on crove_kernel.legal_entity writes crove_kernel.tenant. legal_entity_default_tax_code
--   runs on the nested write and passes, since the statements of an AFTER trigger see the tenant row already changed.
-- - Locks: the tenant row, then the default entity, the order kernel.org.set_tax_code already took.
-- - A code another entity of the org already holds fails the tenant's update on legal_entity_tax_code_uq, so the two
--   rows never disagree; kernel.org.set_tax_code checks that first and answers LEGAL_ENTITY_TAX_CODE_TAKEN.
--
-- A default entity a staff change left on an old code before this file is set to its org's code below, unless another
-- entity of the org holds that code: that one stays as it is (and kernel.org.set_tax_code keeps refusing it) until
-- the other entity's code changes and an owner sets the org's code again. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.tenant_default_entity_tax_code() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_kernel.legal_entity e
     SET tax_code = NEW.tax_code, updated_by = crove_kernel.ctx_user_id(), updated_at = pg_catalog.now()
   WHERE e.org_id = NEW.org_id AND e.is_default AND e.tax_code IS DISTINCT FROM NEW.tax_code;
  RETURN NULL;
END $$;
-- EXECUTE matrix: callable by nobody.
REVOKE ALL ON FUNCTION crove_kernel.tenant_default_entity_tax_code() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS tenant_default_entity_tax_code ON crove_kernel.tenant;
CREATE TRIGGER tenant_default_entity_tax_code AFTER UPDATE OF tax_code ON crove_kernel.tenant
  FOR EACH ROW WHEN (OLD.tax_code IS DISTINCT FROM NEW.tax_code)
  EXECUTE FUNCTION crove_kernel.tenant_default_entity_tax_code();

-- The repair of a default entity already left behind (above). Nothing on the tenant row changes.
UPDATE crove_kernel.legal_entity e
   SET tax_code = t.tax_code, updated_by = NULL, updated_at = pg_catalog.now()
  FROM crove_kernel.tenant t
 WHERE t.org_id = e.org_id
   AND e.is_default
   AND e.tax_code IS DISTINCT FROM t.tax_code
   AND NOT EXISTS (
     SELECT 1 FROM crove_kernel.legal_entity o WHERE o.org_id = e.org_id AND o.id <> e.id AND o.tax_code = t.tax_code
   );
