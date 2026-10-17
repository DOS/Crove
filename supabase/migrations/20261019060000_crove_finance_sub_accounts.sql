-- Crove finance (issue #319): an org's own sub-accounts under the TT133 chart (bank accounts per bank, cost centers),
-- usable everywhere an account code is: purchase lines, journal lines and a vendor's default debit account. Idempotent.
--
-- The model:
--   - crove_finance.account stays the global TT133 chart, read-only for every org.
--   - crove_finance.org_account holds one org's sub-accounts. A code extends its parent's code, either with digits
--     (11211 under 1121, Vietnamese practice for level 2 and 3 accounts) or with a dot and a short upper-case tag
--     (1121.VCB). The parent is a TT133 account or another digit-only sub-account of the same org, so every
--     sub-account rolls up to exactly one TT133 account (root_code, filled by a trigger): it inherits that account's
--     type and normal balance, and every report that reads accounts by code prefix (B01-DNN, B02-DNN) counts it under
--     its parent without any mapping.
--   - Code, parent and root never change and a row is never deleted, so a code written into the ledger always resolves
--     to the same account. Renaming changes only the label; deactivating hides it from pickers and refuses new uses.
--   - journal_line.account_code, purchase_line.debit_account and vendor_account_rule.debit_account referenced
--     crove_finance.account by a foreign key, which cannot also reach a per-org table. Each keeps a check in its
--     place (a trigger raising 23503, like the foreign key did) that the code is a TT133 account or a sub-account of
--     the row's org. Journal and purchase lines accept an inactive sub-account: a reversal must mirror the entry it
--     reverses whatever happened to the account since; the commands refuse inactive accounts for new postings. A
--     vendor default must be active, and an account stays active while it is some vendor's default (both checks take
--     a row lock on the sub-account, so neither can slip past the other).
--   - The global chart's codes become immutable too (no delete, no code change), since nothing else holds them now.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.org_account (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  code text NOT NULL CHECK (code ~ '^[0-9]{3,10}(\.[A-Z0-9]{1,20})?$'),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 200),
  parent_code text NOT NULL,
  -- The TT133 account this one rolls up to (set by the insert trigger).
  root_code text NOT NULL REFERENCES crove_finance.account (code),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT org_account_code_uq UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS org_account_parent_idx ON crove_finance.org_account (org_id, parent_code);
CREATE INDEX IF NOT EXISTS vendor_account_rule_account_idx ON crove_finance.vendor_account_rule (org_id, debit_account);

SELECT crove_kernel.apply_tenant_rls('crove_finance.org_account');
-- Tenant roles read and insert; they update only the label, the active flag and who changed it; nobody deletes.
REVOKE UPDATE, DELETE ON crove_finance.org_account FROM crove_tenant;
GRANT UPDATE (name, active, updated_by) ON crove_finance.org_account TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Sub-account rules
-- ---------------------------------------------------------------------------
-- Insert: the parent exists (a TT133 account, or an active digit-only sub-account of the same org), the code extends
-- the parent's code by digits or by a dot and a tag, no TT133 account has the code, and root_code is the parent's
-- TT133 root. Runs as the caller, so a parent the caller cannot see counts as missing.
CREATE OR REPLACE FUNCTION crove_finance.org_account_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_root text;
  v_suffix text;
BEGIN
  IF EXISTS (SELECT 1 FROM crove_finance.account a WHERE a.code = NEW.code) THEN
    RAISE EXCEPTION 'account % is a TT133 account; a sub-account needs a code of its own', NEW.code USING ERRCODE = '23505';
  END IF;
  SELECT a.code INTO v_root FROM crove_finance.account a WHERE a.code = NEW.parent_code;
  IF NOT FOUND THEN
    SELECT p.root_code INTO v_root
    FROM crove_finance.org_account p
    WHERE p.org_id = NEW.org_id AND p.code = NEW.parent_code AND p.active AND p.code !~ '\.';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent account % is not a TT133 account or an active sub-account without a tag', NEW.parent_code
        USING ERRCODE = '23503';
    END IF;
  END IF;
  v_suffix := pg_catalog.substr(NEW.code, pg_catalog.length(NEW.parent_code) + 1);
  IF pg_catalog.left(NEW.code, pg_catalog.length(NEW.parent_code)) <> NEW.parent_code
     OR v_suffix !~ '^([0-9]{1,5}|\.[A-Z0-9]{1,20})$' THEN
    RAISE EXCEPTION 'sub-account % must extend the code of its parent % with digits or a dot and a tag', NEW.code, NEW.parent_code
      USING ERRCODE = '23514';
  END IF;
  NEW.root_code := v_root;
  NEW.active := true;
  NEW.created_at := pg_catalog.now();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS org_account_before_insert ON crove_finance.org_account;
CREATE TRIGGER org_account_before_insert
  BEFORE INSERT ON crove_finance.org_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.org_account_before_insert();

-- Update: only name, active and updated_by change (the column grant says the same for tenant roles; this holds for
-- every role). Deactivating is refused while the account is some vendor's default or has an active sub-account;
-- reactivating is refused while its parent sub-account is inactive. The lock on the row this update takes is what
-- the vendor default check waits for (check_account_ref), so the two never both pass.
CREATE OR REPLACE FUNCTION crove_finance.org_account_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.parent_code IS DISTINCT FROM OLD.parent_code OR NEW.root_code IS DISTINCT FROM OLD.root_code
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sub-account %: only its name and whether it is active can change', OLD.code USING ERRCODE = '42501';
  END IF;
  IF OLD.active AND NOT NEW.active THEN
    IF EXISTS (SELECT 1 FROM crove_finance.vendor_account_rule r WHERE r.org_id = OLD.org_id AND r.debit_account = OLD.code) THEN
      RAISE EXCEPTION 'sub-account % is the default account of a vendor; change the vendor default first', OLD.code
        USING ERRCODE = '23503';
    END IF;
    IF EXISTS (SELECT 1 FROM crove_finance.org_account c WHERE c.org_id = OLD.org_id AND c.parent_code = OLD.code AND c.active) THEN
      RAISE EXCEPTION 'sub-account % has active sub-accounts; deactivate them first', OLD.code USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.active AND NOT OLD.active THEN
    IF EXISTS (SELECT 1 FROM crove_finance.org_account p WHERE p.org_id = OLD.org_id AND p.code = OLD.parent_code AND NOT p.active) THEN
      RAISE EXCEPTION 'sub-account % is under an inactive account; reactivate % first', OLD.code, OLD.parent_code USING ERRCODE = '23503';
    END IF;
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS org_account_before_update ON crove_finance.org_account;
CREATE TRIGGER org_account_before_update
  BEFORE UPDATE ON crove_finance.org_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.org_account_before_update();

-- A sub-account is never deleted (the ledger may name it), by any role.
CREATE OR REPLACE FUNCTION crove_finance.reject_account_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'accounts in %.% are never deleted; deactivate a sub-account instead', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS org_account_no_delete ON crove_finance.org_account;
CREATE TRIGGER org_account_no_delete
  BEFORE DELETE ON crove_finance.org_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.reject_account_delete();
DROP TRIGGER IF EXISTS org_account_no_truncate ON crove_finance.org_account;
CREATE TRIGGER org_account_no_truncate
  BEFORE TRUNCATE ON crove_finance.org_account
  FOR EACH STATEMENT EXECUTE FUNCTION crove_finance.reject_account_delete();

-- ---------------------------------------------------------------------------
-- The global chart keeps its codes
-- ---------------------------------------------------------------------------
-- A TT133 code is never deleted or renumbered (names may still be corrected), and a code an org already uses for a
-- sub-account cannot become a TT133 code: a later migration adding one fails until the overlap is resolved.
CREATE OR REPLACE FUNCTION crove_finance.account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM crove_finance.org_account o WHERE o.code = NEW.code) THEN
      RAISE EXCEPTION 'account % is already a sub-account of an org', NEW.code USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code = OLD.code THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TT133 account codes are never deleted or changed (account %)', OLD.code USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS account_guard ON crove_finance.account;
CREATE TRIGGER account_guard
  BEFORE INSERT OR UPDATE OR DELETE ON crove_finance.account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.account_guard();
DROP TRIGGER IF EXISTS account_no_truncate ON crove_finance.account;
CREATE TRIGGER account_no_truncate
  BEFORE TRUNCATE ON crove_finance.account
  FOR EACH STATEMENT EXECUTE FUNCTION crove_finance.reject_account_delete();

-- ---------------------------------------------------------------------------
-- Account references: TT133 or the row's org's sub-account
-- ---------------------------------------------------------------------------
-- In place of the foreign keys to crove_finance.account. Fires after the row is written, as the foreign key did, and
-- raises its SQLSTATE (23503). Runs as the writer: a sub-account the writer cannot see (another org's) counts as
-- missing. A vendor default must name an active sub-account, which it locks (FOR SHARE) until commit, so a concurrent
-- deactivation waits and then sees the default.
CREATE OR REPLACE FUNCTION crove_finance.check_account_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_code text;
  v_active boolean;
BEGIN
  -- Separate statements: an expression naming a column the table does not have fails even in a branch not taken.
  IF TG_TABLE_NAME = 'journal_line' THEN
    v_code := NEW.account_code;
  ELSE
    v_code := NEW.debit_account;
  END IF;
  IF EXISTS (SELECT 1 FROM crove_finance.account a WHERE a.code = v_code) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'vendor_account_rule' THEN
    SELECT o.active INTO v_active FROM crove_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code = v_code FOR SHARE;
  ELSE
    SELECT o.active INTO v_active FROM crove_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code = v_code;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "%" violates foreign key check: account % is not in the chart of accounts of org %',
      TG_TABLE_NAME, v_code, NEW.org_id USING ERRCODE = '23503';
  END IF;
  IF TG_TABLE_NAME = 'vendor_account_rule' AND NOT v_active THEN
    RAISE EXCEPTION 'sub-account % is inactive and cannot be a vendor default', v_code USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE crove_finance.journal_line DROP CONSTRAINT IF EXISTS journal_line_account_code_fkey;
ALTER TABLE crove_finance.purchase_line DROP CONSTRAINT IF EXISTS purchase_line_debit_account_fkey;
ALTER TABLE crove_finance.vendor_account_rule DROP CONSTRAINT IF EXISTS vendor_account_rule_debit_account_fkey;

DROP TRIGGER IF EXISTS journal_line_account_ref ON crove_finance.journal_line;
CREATE TRIGGER journal_line_account_ref
  AFTER INSERT ON crove_finance.journal_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_account_ref();
DROP TRIGGER IF EXISTS purchase_line_account_ref ON crove_finance.purchase_line;
CREATE TRIGGER purchase_line_account_ref
  AFTER INSERT ON crove_finance.purchase_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_account_ref();
DROP TRIGGER IF EXISTS vendor_account_rule_account_ref ON crove_finance.vendor_account_rule;
CREATE TRIGGER vendor_account_rule_account_ref
  AFTER INSERT OR UPDATE OF debit_account ON crove_finance.vendor_account_rule
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_account_ref();

-- Trigger functions only; nobody calls them directly.
REVOKE ALL ON FUNCTION
  crove_finance.org_account_before_insert(),
  crove_finance.org_account_before_update(),
  crove_finance.reject_account_delete(),
  crove_finance.account_guard(),
  crove_finance.check_account_ref()
FROM PUBLIC, crove_tenant, crove_definer_tenant;
