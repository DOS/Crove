-- Crove finance (issue #1923, from the security review of #1920): the audit row that stands for a VAT return's filed
-- mark names the same legal entity as the row. Idempotent; applied files stay untouched.
--
-- crove_finance.vat_return_filed_requires_audit  the body of 20261102070000_crove_finance_vat_return_filed.sql, matching
--     the audit row's detail.legal_entity_id too. Before, an ok finance.vat.return_mark row of the same user, period and
--     transaction stood for a mark of any entity of the org, so the branch's audit row could cover a default entity's
--     row written beside it. vat_return_filed_guard's entity check refuses that row today; this keeps the audit check
--     sound on its own if the guard is ever loosened.
--     The command writes legal_entity_id in every audit row since #1280 (#1531), on both the filed and the withdrawn
--     path, and the value is the id resolveLegalEntity read from crove_kernel.legal_entity, the same one it inserts;
--     lower() keeps a canonical uuid text equal to the column's text whatever case a writer used. The trigger stays as it
--     is (deferred to commit); only its function is replaced. Staff are exempt, as before.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_finance.vat_return_filed_requires_audit()
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
    WHERE a.org_id = NEW.org_id
      AND a.command = 'finance.vat.return_mark'
      AND a.outcome = 'ok'
      AND a.actor_type = 'user'
      AND a.actor_id = NEW.marked_by
      AND a.occurred_at = pg_catalog.now()
      AND a.detail ->> 'period' IS NOT DISTINCT FROM NEW.period
      AND pg_catalog.lower(a.detail ->> 'legal_entity_id') IS NOT DISTINCT FROM NEW.legal_entity_id::text
  ) THEN
    RAISE EXCEPTION 'VAT_RETURN_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION crove_finance.vat_return_filed_requires_audit() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
