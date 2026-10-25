-- Crove finance (issue #1401, ADR-0021 section 2): the cash and journal vouchers (PT, PC, BC, BN, NVK) move onto the
-- kernel's gapless number series (20261103030000_crove_kernel_number_series.sql, which describes the design, the
-- backfill decision and the triggers). Idempotent; applied files stay untouched.
--
-- Cross-module statements: the backfill writes the kernel's number_series_policy, number_series and number_allocation
-- rows for the vouchers numbered before; each carries a migration-lint waiver. Everything else here is crove_finance.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- Backfill: the existing vouchers keep their numbers (see the header)
-- ---------------------------------------------------------------------------
-- No voucher may be written while the series are built from them; the ALTERs below take this lock anyway.
LOCK TABLE crove_finance.cash_voucher, crove_finance.journal_voucher IN ACCESS EXCLUSIVE MODE;

-- number_period: '-' for every voucher numbered before (a column default, no rewrite); the trigger sets it on every
-- insert from now on. A row written with triggers off (replica mode: a restore, a test fixture) keeps the default.
ALTER TABLE crove_finance.cash_voucher ADD COLUMN IF NOT EXISTS number_period text NOT NULL DEFAULT '-';
ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS number_period text NOT NULL DEFAULT '-';
ALTER TABLE crove_finance.cash_voucher ADD COLUMN IF NOT EXISTS number_allocation_id uuid;
ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS number_allocation_id uuid;

-- The series of the vouchers numbered before this migration (those without an allocation): reset 'never', one '-'
-- series each, continuing after the highest number.
-- migration-lint: cross-module #1401: the existing vouchers' numbers are recorded in the kernel's number series
WITH v AS (
  SELECT c.org_id, c.legal_entity_id, 'finance.cash_voucher.' || c.voucher_type AS doc_type, c.number
  FROM crove_finance.cash_voucher c WHERE c.number_allocation_id IS NULL
  UNION ALL
  SELECT j.org_id, j.legal_entity_id, 'finance.journal_voucher', j.number
  FROM crove_finance.journal_voucher j WHERE j.number_allocation_id IS NULL
)
INSERT INTO crove_kernel.number_series_policy (org_id, legal_entity_id, doc_type, reset, updated_by)
SELECT DISTINCT v.org_id, v.legal_entity_id, v.doc_type, 'never', NULL::uuid FROM v
ON CONFLICT (org_id, legal_entity_id, doc_type) DO NOTHING;

-- migration-lint: cross-module #1401: the existing vouchers' numbers are recorded in the kernel's number series
WITH v AS (
  SELECT c.org_id, c.legal_entity_id, 'finance.cash_voucher.' || c.voucher_type AS doc_type, c.number
  FROM crove_finance.cash_voucher c WHERE c.number_allocation_id IS NULL
  UNION ALL
  SELECT j.org_id, j.legal_entity_id, 'finance.journal_voucher', j.number
  FROM crove_finance.journal_voucher j WHERE j.number_allocation_id IS NULL
)
INSERT INTO crove_kernel.number_series (org_id, legal_entity_id, doc_type, period_key, next_number)
SELECT v.org_id, v.legal_entity_id, v.doc_type, '-', pg_catalog.max(v.number) + 1 FROM v
GROUP BY v.org_id, v.legal_entity_id, v.doc_type
ON CONFLICT (org_id, legal_entity_id, doc_type, period_key) DO NOTHING;

-- migration-lint: cross-module #1401: the existing vouchers' numbers are recorded in the kernel's number series
INSERT INTO crove_kernel.number_allocation (org_id, series_id, number, target_type, target_id, allocated_by, allocated_at)
SELECT c.org_id, s.id, c.number, 'finance.cash_voucher', c.id, c.created_by, c.created_at
FROM crove_finance.cash_voucher c
JOIN crove_kernel.number_series s
  ON s.org_id = c.org_id AND s.legal_entity_id = c.legal_entity_id AND s.doc_type = 'finance.cash_voucher.' || c.voucher_type AND s.period_key = '-'
WHERE c.number_allocation_id IS NULL
ON CONFLICT DO NOTHING;

-- migration-lint: cross-module #1401: the existing vouchers' numbers are recorded in the kernel's number series
INSERT INTO crove_kernel.number_allocation (org_id, series_id, number, target_type, target_id, allocated_by, allocated_at)
SELECT j.org_id, s.id, j.number, 'finance.journal_voucher', j.id, j.created_by, j.created_at
FROM crove_finance.journal_voucher j
JOIN crove_kernel.number_series s
  ON s.org_id = j.org_id AND s.legal_entity_id = j.legal_entity_id AND s.doc_type = 'finance.journal_voucher' AND s.period_key = '-'
WHERE j.number_allocation_id IS NULL
ON CONFLICT DO NOTHING;

-- The allocation of a voucher, for the rewrite below only (dropped at the end of this migration).
CREATE OR REPLACE FUNCTION crove_finance.voucher_backfill_allocation(p_org_id uuid, p_target_type text, p_target_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.id FROM crove_kernel.number_allocation a
  WHERE a.org_id = p_org_id AND a.target_type = p_target_type AND a.target_id = p_target_id
$$;
REVOKE ALL ON FUNCTION crove_finance.voucher_backfill_allocation(uuid, text, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DO $$
BEGIN
  -- Rewrites, not UPDATEs: the vouchers are append-only, and no row trigger fires (see the header). A table whose
  -- vouchers all have their allocation is not rewritten.
  IF EXISTS (SELECT 1 FROM crove_finance.cash_voucher WHERE number_allocation_id IS NULL) THEN
    ALTER TABLE crove_finance.cash_voucher ALTER COLUMN number_allocation_id TYPE uuid
      USING coalesce(number_allocation_id, crove_finance.voucher_backfill_allocation(org_id, 'finance.cash_voucher', id));
  END IF;
  IF EXISTS (SELECT 1 FROM crove_finance.journal_voucher WHERE number_allocation_id IS NULL) THEN
    ALTER TABLE crove_finance.journal_voucher ALTER COLUMN number_allocation_id TYPE uuid
      USING coalesce(number_allocation_id, crove_finance.voucher_backfill_allocation(org_id, 'finance.journal_voucher', id));
  END IF;
END $$;
DROP FUNCTION crove_finance.voucher_backfill_allocation(uuid, text, uuid);

-- number_allocation_id stays nullable: the insert trigger sets it on every row it numbers, but a row written with
-- triggers off (replica mode: a restore, the WORM and paging test fixtures) has no allocation. Where it is set, the
-- foreign key below holds it to the allocation.

-- Keys: the number within its period, and the allocation (one voucher per allocation; also the foreign key's index).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.cash_voucher'::regclass
                   AND c.conname = 'cash_voucher_number_uq' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%number_period%') THEN
    ALTER TABLE crove_finance.cash_voucher DROP CONSTRAINT IF EXISTS cash_voucher_number_uq;
    ALTER TABLE crove_finance.cash_voucher ADD CONSTRAINT cash_voucher_number_uq UNIQUE (org_id, legal_entity_id, voucher_type, number_period, number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.journal_voucher'::regclass
                   AND c.conname = 'journal_voucher_number_uq' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%number_period%') THEN
    ALTER TABLE crove_finance.journal_voucher DROP CONSTRAINT IF EXISTS journal_voucher_number_uq;
    ALTER TABLE crove_finance.journal_voucher ADD CONSTRAINT journal_voucher_number_uq UNIQUE (org_id, legal_entity_id, number_period, number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.cash_voucher'::regclass
                   AND c.conname = 'cash_voucher_allocation_uq') THEN
    ALTER TABLE crove_finance.cash_voucher ADD CONSTRAINT cash_voucher_allocation_uq UNIQUE (org_id, number_allocation_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.journal_voucher'::regclass
                   AND c.conname = 'journal_voucher_allocation_uq') THEN
    ALTER TABLE crove_finance.journal_voucher ADD CONSTRAINT journal_voucher_allocation_uq UNIQUE (org_id, number_allocation_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.cash_voucher'::regclass
                   AND c.conname = 'cash_voucher_allocation_fk') THEN
    ALTER TABLE crove_finance.cash_voucher ADD CONSTRAINT cash_voucher_allocation_fk
      FOREIGN KEY (org_id, number_allocation_id) REFERENCES crove_kernel.number_allocation (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'crove_finance.journal_voucher'::regclass
                   AND c.conname = 'journal_voucher_allocation_fk') THEN
    ALTER TABLE crove_finance.journal_voucher ADD CONSTRAINT journal_voucher_allocation_fk
      FOREIGN KEY (org_id, number_allocation_id) REFERENCES crove_kernel.number_allocation (org_id, id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The voucher triggers: numbers from the series (see the header)
-- ---------------------------------------------------------------------------
-- A row this trigger does not number: one with no entity (the writer's scope left the default entity out), of another
-- org than the context's, or of an entity outside the context's le_scope. Row security refuses each after the BEFORE
-- triggers; the trigger only stays clear of a series the writer may not touch. No context (the database owner, a
-- migration): every row is numbered.
CREATE OR REPLACE FUNCTION crove_finance.voucher_numbered_here(p_org_id uuid, p_legal_entity_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_legal_entity_id IS NOT NULL
     AND (crove_kernel.ctx_org_id() IS NULL OR p_org_id = crove_kernel.ctx_org_id())
     AND (crove_kernel.ctx_le_scope() IS NULL OR crove_kernel.ctx_le_allowed(p_legal_entity_id))
$$;
REVOKE ALL ON FUNCTION crove_finance.voucher_numbered_here(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- PT, PC, BC, BN: series finance.cash_voucher.<voucher_type> of the voucher's entity, by the voucher's date. The
-- caller's number, period and allocation are ignored.
CREATE OR REPLACE FUNCTION crove_finance.cash_voucher_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v record;
BEGIN
  IF NOT crove_finance.voucher_numbered_here(NEW.org_id, NEW.legal_entity_id) THEN
    NEW.number_allocation_id := NULL;
    RETURN NEW;
  END IF;
  SELECT a.period_key, a.number, a.allocation_id INTO v
  FROM crove_kernel.number_allocate(NEW.org_id, NEW.legal_entity_id, 'finance.cash_voucher.' || NEW.voucher_type, NEW.voucher_date,
                                    'finance.cash_voucher', NEW.id) a;
  NEW.number := v.number;
  NEW.number_period := v.period_key;
  NEW.number_allocation_id := v.allocation_id;
  RETURN NEW;
END $$;

-- NVK: series finance.journal_voucher of the voucher's entity, by the voucher's date.
CREATE OR REPLACE FUNCTION crove_finance.journal_voucher_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v record;
BEGIN
  IF NOT crove_finance.voucher_numbered_here(NEW.org_id, NEW.legal_entity_id) THEN
    NEW.number_allocation_id := NULL;
    RETURN NEW;
  END IF;
  SELECT a.period_key, a.number, a.allocation_id INTO v
  FROM crove_kernel.number_allocate(NEW.org_id, NEW.legal_entity_id, 'finance.journal_voucher', NEW.voucher_date,
                                    'finance.journal_voucher', NEW.id) a;
  NEW.number := v.number;
  NEW.number_period := v.period_key;
  NEW.number_allocation_id := v.allocation_id;
  RETURN NEW;
END $$;

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION crove_finance.cash_voucher_before_insert(), crove_finance.journal_voucher_before_insert()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The triggers themselves are unchanged (cash_voucher_number, journal_voucher_number: BEFORE INSERT, after
-- b_legal_entity by name); re-created here so this migration states the order it relies on.
DROP TRIGGER IF EXISTS cash_voucher_number ON crove_finance.cash_voucher;
CREATE TRIGGER cash_voucher_number BEFORE INSERT ON crove_finance.cash_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.cash_voucher_before_insert();
DROP TRIGGER IF EXISTS journal_voucher_number ON crove_finance.journal_voucher;
CREATE TRIGGER journal_voucher_number BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.journal_voucher_before_insert();

ANALYZE crove_kernel.number_series, crove_kernel.number_allocation, crove_kernel.number_void, crove_kernel.number_series_policy,
  crove_finance.cash_voucher, crove_finance.journal_voucher;
