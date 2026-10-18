-- Crove finance (issue #465): the purchase-invoice list the accountant exports from the tax authority's e-invoice
-- portal (hoadondientu.gdt.gov.vn, Excel), stored per org and VAT period so Crove can show which invoices the tax
-- authority has that Crove lacks, and the other way round. Idempotent; applied files stay untouched.
--
-- crove_kernel.file.source 'import'   a spreadsheet uploaded for a module's import (here the portal list). Stored,
--                                      hashed and pinned to its object version like every file (ADR-0013), but it is
--                                      not an accounting document: it never goes to extraction or the Inbox.
-- crove_finance.portal_invoice_list   one imported file for one period: pending until the worker has read it in the
--                                      parsing sandbox, then done (its rows are in portal_invoice_row) or failed (with
--                                      a reason). A list is never deleted; removing it from a period sets removed_at.
--                                      The same file is imported at most once per period while not removed.
-- crove_finance.portal_invoice_row    the rows of a done list, as the sandbox read them and the worker checked them.
--                                      Append-only: a corrected list is a new import.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.file DROP CONSTRAINT IF EXISTS file_source_check;
ALTER TABLE crove_kernel.file ADD CONSTRAINT file_source_check CHECK (source IN ('upload', 'email', 'social', 'import'));

CREATE TABLE IF NOT EXISTS crove_finance.portal_invoice_list (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- A VAT period: a month (2026-09) or a quarter (2026-Q3), as the VAT working names it.
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  file_id uuid NOT NULL,
  filename text NOT NULL CHECK (pg_catalog.length(filename) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error text CHECK (error IS NULL OR pg_catalog.length(error) <= 2000),
  row_count integer CHECK (row_count IS NULL OR row_count BETWEEN 0 AND 20000),
  -- What the file says about itself, when it says it: the date range of the lookup and the buyer's tax code.
  list_from date,
  list_to date,
  buyer_tax_code text CHECK (buyer_tax_code IS NULL OR buyer_tax_code ~ '^[0-9]{10}(-[0-9]{3})?$|^[0-9]{12}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  recorded_at timestamptz,
  removed_at timestamptz,
  removed_by uuid,
  PRIMARY KEY (org_id, id),
  CONSTRAINT portal_invoice_list_file_fk FOREIGN KEY (org_id, file_id) REFERENCES crove_kernel.file (org_id, id),
  CONSTRAINT portal_invoice_list_result CHECK (
    (status = 'pending' AND recorded_at IS NULL AND row_count IS NULL AND error IS NULL)
    OR (status = 'done' AND recorded_at IS NOT NULL AND row_count IS NOT NULL AND error IS NULL)
    OR (status = 'failed' AND recorded_at IS NOT NULL AND row_count IS NULL AND error IS NOT NULL)
  ),
  CONSTRAINT portal_invoice_list_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_invoice_list_file_uq
  ON crove_finance.portal_invoice_list (org_id, period, file_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS portal_invoice_list_period_idx ON crove_finance.portal_invoice_list (org_id, period, created_at);
CREATE INDEX IF NOT EXISTS portal_invoice_list_file_idx ON crove_finance.portal_invoice_list (org_id, file_id);

SELECT crove_kernel.apply_tenant_rls('crove_finance.portal_invoice_list');
-- Tenant roles read and insert; they update only the outcome columns and the removal; nobody deletes.
REVOKE UPDATE, DELETE ON crove_finance.portal_invoice_list FROM crove_tenant;
GRANT UPDATE (status, error, row_count, list_from, list_to, buyer_tax_code, recorded_at, removed_at, removed_by)
  ON crove_finance.portal_invoice_list TO crove_tenant;

-- The outcome is written once (pending to done or failed, with the database clock), and a removal is never undone.
-- The column grant keeps tenant roles off the other columns; this holds for every role.
CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_list_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.file_id IS DISTINCT FROM OLD.file_id OR NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'portal invoice list %: only its outcome and its removal can change', OLD.id USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.status, NEW.error, NEW.row_count, NEW.list_from, NEW.list_to, NEW.buyer_tax_code, NEW.recorded_at)
       IS DISTINCT FROM (OLD.status, OLD.error, OLD.row_count, OLD.list_from, OLD.list_to, OLD.buyer_tax_code, OLD.recorded_at) THEN
    RAISE EXCEPTION 'portal invoice list % already has its outcome', OLD.id USING ERRCODE = '42501';
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

DROP TRIGGER IF EXISTS portal_invoice_list_before_update ON crove_finance.portal_invoice_list;
CREATE TRIGGER portal_invoice_list_before_update
  BEFORE UPDATE ON crove_finance.portal_invoice_list
  FOR EACH ROW EXECUTE FUNCTION crove_finance.portal_invoice_list_before_update();

-- A new list starts pending, stamped with the database clock.
CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_list_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a portal invoice list starts pending and not removed' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_invoice_list_before_insert ON crove_finance.portal_invoice_list;
CREATE TRIGGER portal_invoice_list_before_insert
  BEFORE INSERT ON crove_finance.portal_invoice_list
  FOR EACH ROW EXECUTE FUNCTION crove_finance.portal_invoice_list_before_insert();

CREATE OR REPLACE FUNCTION crove_finance.reject_portal_list_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'portal invoice lists are never deleted; remove one from its period instead' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS portal_invoice_list_no_delete ON crove_finance.portal_invoice_list;
CREATE TRIGGER portal_invoice_list_no_delete
  BEFORE DELETE ON crove_finance.portal_invoice_list
  FOR EACH ROW EXECUTE FUNCTION crove_finance.reject_portal_list_delete();
DROP TRIGGER IF EXISTS portal_invoice_list_no_truncate ON crove_finance.portal_invoice_list;
CREATE TRIGGER portal_invoice_list_no_truncate
  BEFORE TRUNCATE ON crove_finance.portal_invoice_list
  FOR EACH STATEMENT EXECUTE FUNCTION crove_finance.reject_portal_list_delete();

CREATE TABLE IF NOT EXISTS crove_finance.portal_invoice_row (
  org_id uuid NOT NULL,
  list_id uuid NOT NULL,
  -- The row's number in the sheet, so a problem can be pointed at in the file.
  row_no integer NOT NULL CHECK (row_no BETWEEN 1 AND 1048576),
  seller_tax_code text NOT NULL CHECK (seller_tax_code ~ '^[0-9]{10}(-[0-9]{3})?$|^[0-9]{12}$'),
  seller_name text NOT NULL DEFAULT '' CHECK (pg_catalog.length(seller_name) <= 500),
  -- Ký hiệu mẫu số (1 to 9) and ký hiệu hóa đơn (C26TAA), normalized like the documents Crove reads.
  template text CHECK (template IS NULL OR template ~ '^[0-9A-Z]{1,11}$'),
  series text NOT NULL CHECK (pg_catalog.length(series) BETWEEN 1 AND 20),
  number text NOT NULL CHECK (pg_catalog.length(number) BETWEEN 1 AND 20),
  issue_date date NOT NULL,
  currency text NOT NULL DEFAULT 'VND' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal crove_finance.amount,
  vat_amount crove_finance.amount,
  total crove_finance.amount,
  -- original, replacement, adjustment: a valid invoice. replaced, adjusted: a valid invoice another one replaced or
  -- adjusted (a replaced one no longer counts). cancelled: cancelled, never counts. unknown: a status the reader did
  -- not recognize (status_label keeps the portal's own words).
  status text NOT NULL CHECK (status IN ('original', 'replacement', 'adjustment', 'replaced', 'adjusted', 'cancelled', 'unknown')),
  status_label text CHECK (status_label IS NULL OR pg_catalog.length(status_label) <= 200),
  check_result text CHECK (check_result IS NULL OR pg_catalog.length(check_result) <= 200),
  PRIMARY KEY (org_id, list_id, row_no),
  CONSTRAINT portal_invoice_row_list_fk FOREIGN KEY (org_id, list_id) REFERENCES crove_finance.portal_invoice_list (org_id, id)
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.portal_invoice_row', true);
SELECT crove_kernel.make_append_only('crove_finance.portal_invoice_row');

-- Rows join only a pending list (the command that records the outcome writes them before it marks the list done).
-- Runs as the writer: a list the writer cannot see is left to the foreign key and row security.
CREATE OR REPLACE FUNCTION crove_finance.portal_invoice_row_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  SELECT l.status INTO v_status FROM crove_finance.portal_invoice_list l WHERE l.org_id = NEW.org_id AND l.id = NEW.list_id;
  IF FOUND AND v_status <> 'pending' THEN
    RAISE EXCEPTION 'portal invoice list % already has its outcome', NEW.list_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_invoice_row_before_insert ON crove_finance.portal_invoice_row;
CREATE TRIGGER portal_invoice_row_before_insert
  BEFORE INSERT ON crove_finance.portal_invoice_row
  FOR EACH ROW EXECUTE FUNCTION crove_finance.portal_invoice_row_before_insert();

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.portal_invoice_list_before_update(), crove_finance.portal_invoice_list_before_insert(),
  crove_finance.reject_portal_list_delete(), crove_finance.portal_invoice_row_before_insert() FROM PUBLIC;

-- The worker's queue for reading an imported list (apps/kernel/src/jobs-schema.ts QUEUES.portalList): one job per
-- list (singleton key <org>:<list>). create_queue skips a queue that exists.
SELECT crove_jobs.create_queue('finance-portal-list', '{"policy":"standard"}'::jsonb);
