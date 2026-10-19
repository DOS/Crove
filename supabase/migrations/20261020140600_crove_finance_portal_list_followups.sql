-- Crove finance (issue #506): follow-ups to the tax portal purchase list (#465). Idempotent; applied files stay
-- untouched.
--
-- crove_finance.portal_invoice_list.own_sales_count, .other_buyer_count
--   Rows of a done list the worker dropped because they are not the org's purchases: the org is the seller (its own
--   sales), or the row names another buyer. Shown next to the skipped rows: a misread buyer code would otherwise hide
--   an invoice the comparison should have had.
--
-- Only the system context records a list (defense in depth; the command layer already makes
-- finance.portal_list.record system only): tenant roles keep the column grant on the outcome, which the worker's
-- commands use, but in a member's or an agent's context the outcome cannot change and no row can be added. Removal
-- (removed_at, removed_by) stays open to any context, as finance.portal_list.remove needs. A write without a context
-- (the database owner) is left alone; tenant roles without one see no rows at all.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.portal_invoice_list
  ADD COLUMN IF NOT EXISTS own_sales_count integer NOT NULL DEFAULT 0 CHECK (own_sales_count BETWEEN 0 AND 1048576);
ALTER TABLE crove_finance.portal_invoice_list
  ADD COLUMN IF NOT EXISTS other_buyer_count integer NOT NULL DEFAULT 0 CHECK (other_buyer_count BETWEEN 0 AND 1048576);
GRANT UPDATE (own_sales_count, other_buyer_count) ON crove_finance.portal_invoice_list TO crove_tenant;

-- As before, plus the new outcome columns, and the outcome changes only in the system context.
CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_list_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.filename IS DISTINCT FROM OLD.filename
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

-- A new list starts pending with no outcome at all (the result constraint leaves the file's own range, buyer and the
-- dropped-row counts open), stamped with the database clock.
CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_list_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.removed_at IS NOT NULL OR NEW.removed_by IS NOT NULL
     OR NEW.list_from IS NOT NULL OR NEW.list_to IS NOT NULL OR NEW.buyer_tax_code IS NOT NULL
     OR NEW.own_sales_count <> 0 OR NEW.other_buyer_count <> 0 THEN
    RAISE EXCEPTION 'a portal invoice list starts pending, without an outcome and not removed' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $$;

-- Rows join only a pending list, and only in the system context of the row's org (the worker recording the list).
-- Runs as the writer: a list the writer cannot see, or a row for another org, is left to the foreign key and row
-- security, which refuse it.
CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_row_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.org_id = crove_kernel.ctx_org_id() AND crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'portal invoice rows are written only by the worker that reads the list' USING ERRCODE = '42501';
  END IF;
  SELECT l.status INTO v_status FROM crove_finance.portal_invoice_list l WHERE l.org_id = NEW.org_id AND l.id = NEW.list_id;
  IF FOUND AND v_status <> 'pending' THEN
    RAISE EXCEPTION 'portal invoice list % already has its outcome', NEW.list_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- CREATE OR REPLACE keeps the privileges; repeated so this file states them on its own.
REVOKE ALL ON FUNCTION crove_finance.portal_invoice_list_before_update(), crove_finance.portal_invoice_list_before_insert(),
  crove_finance.portal_invoice_row_before_insert() FROM PUBLIC;
