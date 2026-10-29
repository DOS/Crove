-- Crove finance (issue #1508): a VAT return is marked filed by an owner or an admin, as before, or by a holder of
-- finance.vat.file for the return's legal entity: a finance.chief_accountant (every entity) or a
-- finance.entity_chief_accountant of that entity (20261106110000_crove_kernel_vat_file_permission.sql). Idempotent;
-- applied files stay untouched.
--
-- crove_finance.vat_return_filed_guard  the body of 20261102070000_crove_finance_vat_return_filed.sql with the marker's
--     right widened by that permission (org-wide through ctx_has_permission, per entity through ctx_permission_entities,
--     both for the context's user, who must be the marker, and never a viewer). Staff, the system context, the context
--     and marker checks and the audit requirement (vat_return_filed_requires_audit) are unchanged. The trigger stays as
--     it is; only its function is replaced.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.vat_return_filed_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_staff boolean;
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
BEGIN
  SELECT r.rolsuper
         OR pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID), 'USAGE')
    INTO v_staff
  FROM pg_catalog.pg_roles r WHERE r.rolname = SESSION_USER;
  IF COALESCE(v_staff, false) THEN
    RETURN NULL;
  END IF;
  IF v_org IS NOT NULL AND v_org = NEW.org_id AND v_actor = 'system' THEN
    RETURN NULL;
  END IF;
  IF v_org IS NULL
     OR v_org IS DISTINCT FROM NEW.org_id
     OR v_actor IS DISTINCT FROM 'user'
     OR crove_kernel.ctx_user_id() IS DISTINCT FROM NEW.marked_by
     OR NOT (
       EXISTS (
         SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = NEW.org_id AND m.user_id = NEW.marked_by AND m.role IN ('owner', 'admin'))
       -- A chief accountant (#1508): finance.vat.file org-wide, or for this return's legal entity. Both answer for the
       -- context's user, who is the marker (checked above), and never for a viewer.
       OR crove_kernel.ctx_has_permission('finance.vat.file') IS TRUE
       OR (NEW.legal_entity_id IS NOT NULL AND NEW.legal_entity_id::text = ANY (COALESCE(crove_kernel.ctx_permission_entities('finance.vat.file'), ARRAY[]::text[])))
     ) THEN
    RAISE EXCEPTION 'VAT_RETURN_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only finance.vat.return_mark, run by an owner or an admin of the org or a holder of finance.vat.file for the return''s entity, marks a VAT return filed';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION crove_finance.vat_return_filed_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
