-- Crove finance (issue #919): the register of fixed assets and prepaid costs, and their monthly depreciation and
-- allocation. A TT133 monthly close books, for each fixed asset, Dr expense / Cr accumulated depreciation (214x), and
-- for each prepaid cost or tool, Dr expense / Cr 242. Idempotent; applied files stay untouched.
--
-- crove_finance.fixed_asset, one row per asset, never deleted:
--   - kind 'fixed_asset': asset_account under 211 or 213, accumulated_account under 214;
--   - kind 'prepaid_cost': asset_account under 242 and no accumulated account (the allocation credits 242 itself);
--   - expense_account: where the monthly amount goes (154, 6xx or 8xx);
--   - cost over months of use from start_month (the first day of a month), straight line, the last month taking the
--     remainder (modules/finance/src/domain/depreciation.ts);
--   - source_document_id and source_line_no: the purchase line it came from, when it was created from one;
--   - ended_month, end_reason, ended_by: the schedule stopped early (disposed of, written off), the last month that
--     still counts. Tenant roles update only these (a column grant), and only once.
-- crove_finance.depreciation_line, append-only: the amount of one asset for one month, and the journal entry
-- (source finance.depreciation) that posted it. At most one per asset and month.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.fixed_asset (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('fixed_asset', 'prepaid_cost')),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 500),
  cost numeric(20,4) NOT NULL CHECK (cost > 0),
  asset_account text NOT NULL,
  accumulated_account text,
  expense_account text NOT NULL,
  start_month date NOT NULL CHECK (pg_catalog.date_trunc('month', start_month)::date = start_month),
  months integer NOT NULL CHECK (months BETWEEN 1 AND 600),
  source_document_id uuid,
  source_line_no integer,
  ended_month date CHECK (ended_month IS NULL OR pg_catalog.date_trunc('month', ended_month)::date = ended_month),
  end_reason text CHECK (end_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(end_reason)) BETWEEN 1 AND 500),
  ended_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT fixed_asset_accounts CHECK (
    CASE kind
      WHEN 'fixed_asset' THEN pg_catalog.left(asset_account, 3) IN ('211', '213') AND pg_catalog.left(accumulated_account, 3) = '214'
      ELSE pg_catalog.left(asset_account, 3) = '242' AND accumulated_account IS NULL
    END
    AND (pg_catalog.left(expense_account, 1) IN ('6', '8') OR pg_catalog.left(expense_account, 3) = '154')
  ),
  CONSTRAINT fixed_asset_source CHECK ((source_document_id IS NULL) = (source_line_no IS NULL)),
  CONSTRAINT fixed_asset_source_fk FOREIGN KEY (org_id, source_document_id) REFERENCES crove_finance.purchase_document (org_id, id),
  CONSTRAINT fixed_asset_end CHECK (
    (ended_month IS NULL) = (end_reason IS NULL) AND (ended_month IS NULL) = (ended_by IS NULL)
    AND (ended_month IS NULL OR ended_month >= start_month - interval '1 month')
  )
);
-- One register entry per purchase line.
CREATE UNIQUE INDEX IF NOT EXISTS fixed_asset_source_uq ON crove_finance.fixed_asset (org_id, source_document_id, source_line_no)
  WHERE source_document_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_finance.fixed_asset', true);
GRANT UPDATE (ended_month, end_reason, ended_by) ON crove_finance.fixed_asset TO crove_tenant;

-- The end of a schedule is set once; nothing else of an entry ever changes.
CREATE OR REPLACE FUNCTION crove_finance.fixed_asset_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.ended_month IS NOT NULL THEN
    RAISE EXCEPTION 'fixed asset % already ended', OLD.id USING ERRCODE = '55000';
  END IF;
  IF (NEW.org_id, NEW.id, NEW.kind, NEW.name, NEW.cost, NEW.asset_account, NEW.accumulated_account, NEW.expense_account,
      NEW.start_month, NEW.months, NEW.source_document_id, NEW.source_line_no, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.org_id, OLD.id, OLD.kind, OLD.name, OLD.cost, OLD.asset_account, OLD.accumulated_account, OLD.expense_account,
      OLD.start_month, OLD.months, OLD.source_document_id, OLD.source_line_no, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'only the end of a fixed asset''s schedule may change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fixed_asset_before_update ON crove_finance.fixed_asset;
CREATE TRIGGER fixed_asset_before_update
  BEFORE UPDATE ON crove_finance.fixed_asset
  FOR EACH ROW EXECUTE FUNCTION crove_finance.fixed_asset_before_update();
REVOKE ALL ON FUNCTION crove_finance.fixed_asset_before_update() FROM PUBLIC, crove_tenant, crove_definer_tenant;

CREATE TABLE IF NOT EXISTS crove_finance.depreciation_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  asset_id uuid NOT NULL,
  month date NOT NULL CHECK (pg_catalog.date_trunc('month', month)::date = month),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  entry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT depreciation_line_asset_fk FOREIGN KEY (org_id, asset_id) REFERENCES crove_finance.fixed_asset (org_id, id),
  CONSTRAINT depreciation_line_month_uq UNIQUE (org_id, asset_id, month)
);
CREATE INDEX IF NOT EXISTS depreciation_line_month_idx ON crove_finance.depreciation_line (org_id, month);

SELECT crove_kernel.apply_tenant_rls('crove_finance.depreciation_line', true);
SELECT crove_kernel.make_append_only('crove_finance.depreciation_line');
