-- Crove kernel (issue #1626, plan §4.10): audit facts keep no value classified pii, contact, payment, national_id,
-- national_id_if_individual or sensitive. kernel.org.set_tax_code now writes a marker naming the class in place of the
-- org's tax code (tenant.tax_code is national_id_if_individual: a household business's tax code is its owner's national
-- id), {"taxCode": {"redacted": "national_id_if_individual"}}, and keeps null for a code that is cleared.
--
-- tenant_tax_code_requires_audit (20261020090000) let a change of the tax code commit only with the command's 'ok' audit
-- row naming the new value. That row no longer names it, so the trigger also accepts the marker when the new code is
-- set. Everything else it checks is unchanged: the command, the outcome, a user actor who is an owner or admin of the
-- org, the transaction's own row; a row naming another value is still refused, and a cleared code still needs a row
-- with a null taxCode. The body is the newest one on main with only that alternative added. Idempotent.
SET LOCAL lock_timeout = '2s';

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
      AND (
        a.detail ->> 'taxCode' IS NOT DISTINCT FROM NEW.tax_code
        OR (NEW.tax_code IS NOT NULL AND a.detail -> 'taxCode' = '{"redacted": "national_id_if_individual"}'::jsonb)
      )
  ) THEN
    RAISE EXCEPTION 'TAX_CODE_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

-- EXECUTE matrix: the trigger's function stays callable by nobody (CREATE OR REPLACE keeps its privileges; repeated
-- here so the file holds on its own).
REVOKE ALL ON FUNCTION crove_kernel.tenant_tax_code_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
