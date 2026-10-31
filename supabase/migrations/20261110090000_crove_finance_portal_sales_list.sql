-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2141, part of M2 "all purchase and sales e-invoices in"): the tax portal's sales list ("hóa
-- đơn điện tử bán ra") through the same import as the purchase list (#465). Idempotent; applied files stay untouched.
--
-- crove_finance.portal_invoice_list.direction   'purchase' (the org is the buyer: every list so far) or 'sale' (the org
--                                               is the seller). Fixed when the list is imported; the lists of the two
--                                               directions of a period never mix, and each has its own limits.
-- crove_finance.portal_invoice_row.buyer_tax_code   the buyer's tax code on the row, as the portal's list names both
--                                               parties. Null on a purchase row (the buyer is the org) and where the
--                                               column is empty (a sale to a person); a sale row's seller_tax_code is
--                                               the org's own.
--
-- The trigger that guards a list's columns is replaced with the same rules, plus: the direction never changes.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.portal_invoice_list
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'purchase' CONSTRAINT portal_invoice_list_direction_check CHECK (direction IN ('purchase', 'sale'));

ALTER TABLE crove_finance.portal_invoice_row
  ADD COLUMN IF NOT EXISTS buyer_tax_code text CONSTRAINT portal_invoice_row_buyer_tax_code_check CHECK (buyer_tax_code IS NULL OR buyer_tax_code ~ '^[0-9]{10}(-[0-9]{3})?$|^[0-9]{12}$');

-- A period's lists are read by direction.
CREATE INDEX IF NOT EXISTS portal_invoice_list_direction_idx ON crove_finance.portal_invoice_list (org_id, period, direction, created_at);

CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_list_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'portal invoice list %: only its outcome and its removal can change', OLD.id USING ERRCODE = '42501';
  END IF;
  IF (NEW.status, NEW.error, NEW.row_count, NEW.list_from, NEW.list_to, NEW.buyer_tax_code, NEW.skipped_count, NEW.skipped,
      NEW.own_sales_count, NEW.other_buyer_count, NEW.recorded_at)
     IS DISTINCT FROM (OLD.status, OLD.error, OLD.row_count, OLD.list_from, OLD.list_to, OLD.buyer_tax_code, OLD.skipped_count, OLD.skipped,
      OLD.own_sales_count, OLD.other_buyer_count, OLD.recorded_at) THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'portal invoice list % already has its outcome', OLD.id USING ERRCODE = '42501';
    END IF;
    IF crove_kernel.ctx_org_id() IS NOT NULL AND crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'portal invoice list %: only the worker that reads the list records its outcome', OLD.id USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'pending' THEN
    NEW.recorded_at := pg_catalog.now();
  END IF;
  IF OLD.removed_at IS NOT NULL AND (NEW.removed_at, NEW.removed_by) IS DISTINCT FROM (OLD.removed_at, OLD.removed_by) THEN
    RAISE EXCEPTION 'portal invoice list % is already removed', OLD.id USING ERRCODE = '42501';
  END IF;
  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    NEW.removed_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;

-- CREATE OR REPLACE keeps the privileges; repeated so this file states them on its own.
REVOKE ALL ON FUNCTION crove_finance.portal_invoice_list_before_update() FROM PUBLIC;
