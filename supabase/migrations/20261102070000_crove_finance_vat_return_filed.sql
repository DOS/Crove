-- Crove finance (issue #1400): the VAT return 01/GTGT marked filed for a period, with the figures the next return
-- needs. Indicator [22] of a return (VAT still deductible, carried forward from the previous period) is the previous
-- return's [43] (VAT still deductible, carried to the next period); see docs/integrations/htkk-01gtgt-xml.md.
-- Idempotent; applied files stay untouched.
--
-- One row per mark, append-only: the latest row of a period (by created_at, then id) is its state, so a correction
-- or a withdrawal adds a row and the history stays, like the rest of the books. status:
--   - filed: the return of the period was marked done (the tax calendar's done mark, crove_kernel.tax_obligation_done,
--     is written in the same command), with [22], [25] and [43] as filed. source says where the figures come from:
--     'entered' (the accountant typed or confirmed them on the VAT screen) or 'computed' (marked done from the tax
--     calendar, so Crove's own working: [22] from the previous return, [25] the suggested deduction);
--   - withdrawn: the done mark was taken back; no figures.
-- finance.vat.return_mark (owners and admins, R1, audited) is the only writer: tenant roles read and insert (the
-- guards below hold an insert to that command, failing closed), nobody updates or deletes.
-- Kept with the books: the org purge never deletes a crove_finance row.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.vat_return_filed (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- A month ("2026-09") or a quarter ("2026-Q3"), as finance.vat.period names it.
  period text NOT NULL CHECK (period ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2]|Q[1-4])$'),
  status text NOT NULL CHECK (status IN ('filed', 'withdrawn')),
  source text CHECK (source IN ('entered', 'computed')),
  -- [22], [25] and [43] in whole dong, as on the return (HTKK holds 14 digits).
  carried_in_amount crove_finance.amount,
  deductible_amount crove_finance.amount,
  carried_out_amount crove_finance.amount,
  marked_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (org_id, id),
  -- A filed mark has a source and every figure; a withdrawal has none.
  CONSTRAINT vat_return_filed_figures CHECK (
    (status = 'filed' AND source IS NOT NULL AND carried_in_amount IS NOT NULL AND deductible_amount IS NOT NULL AND carried_out_amount IS NOT NULL)
    OR (status = 'withdrawn' AND source IS NULL AND carried_in_amount IS NULL AND deductible_amount IS NULL AND carried_out_amount IS NULL)
  ),
  CONSTRAINT vat_return_filed_amounts CHECK (
    (carried_in_amount IS NULL OR (carried_in_amount BETWEEN 0 AND 99999999999999 AND carried_in_amount = pg_catalog.trunc(carried_in_amount)))
    AND (deductible_amount IS NULL OR (deductible_amount BETWEEN 0 AND 99999999999999 AND deductible_amount = pg_catalog.trunc(deductible_amount)))
    AND (carried_out_amount IS NULL OR (carried_out_amount BETWEEN 0 AND 99999999999999 AND carried_out_amount = pg_catalog.trunc(carried_out_amount)))
  )
);

-- The latest mark of a period, and of the period before the one on screen.
CREATE INDEX IF NOT EXISTS vat_return_filed_period_idx ON crove_finance.vat_return_filed (org_id, period, created_at DESC, id DESC);

SELECT crove_kernel.apply_tenant_rls('crove_finance.vat_return_filed', true);
SELECT crove_kernel.make_append_only('crove_finance.vat_return_filed');

-- Only the command writes a row, and the checks fail closed:
-- - vat_return_filed_guard (AFTER INSERT, so the tenant policy refuses a row for another org first, with its own
--   error) refuses every row unless the sealed context is of the row's org and is a user who is an owner or an admin
--   of it and names themselves as marked_by (VAT_RETURN_FORBIDDEN). No context, or a context of another org, is
--   refused. The one other actor let through is the org's own system context, which the RLS matrix's control insert
--   (apps/kernel/test/invariant/rls-matrix.db.test.ts, crove_worker in the system context of its own org) needs; no
--   product path writes the table from it, and such a row cannot commit (next point).
-- - vat_return_filed_requires_audit (deferred to commit) lets a row commit only with the 'ok' audit row of
--   finance.vat.return_mark for its period by that user in the same transaction (the runtime writes it as the command
--   ends), as tenant_tax_code_guard and tenant_tax_code_requires_audit do for the tax code.
-- Staff (a superuser, or a role that can act as the table's owner) are not held back, so a support fix is not locked
-- out.
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
     OR NOT EXISTS (
       SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = NEW.marked_by AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION 'VAT_RETURN_FORBIDDEN' USING ERRCODE = '42501',
      DETAIL = 'only finance.vat.return_mark, run by an owner or an admin of the org, marks a VAT return filed';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS vat_return_filed_guard ON crove_finance.vat_return_filed;
CREATE TRIGGER vat_return_filed_guard AFTER INSERT ON crove_finance.vat_return_filed
  FOR EACH ROW EXECUTE FUNCTION crove_finance.vat_return_filed_guard();

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
  ) THEN
    RAISE EXCEPTION 'VAT_RETURN_UNAUDITED' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS vat_return_filed_requires_audit ON crove_finance.vat_return_filed;
CREATE CONSTRAINT TRIGGER vat_return_filed_requires_audit
  AFTER INSERT ON crove_finance.vat_return_filed
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_finance.vat_return_filed_requires_audit();

-- EXECUTE matrix: the triggers' functions are callable by nobody.
REVOKE ALL ON FUNCTION crove_finance.vat_return_filed_guard(), crove_finance.vat_return_filed_requires_audit()
FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
