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
--   - The global chart now holds the whole TT133 appendix (seeded below), and a digit sub-account goes under the most
--     detailed account its code extends (13321 under 1332, never under 133), so the roll-up by code prefix (B01, B02)
--     and by parent (trial balance, general ledger) agree.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The whole TT133 chart
-- ---------------------------------------------------------------------------
-- Before this migration crove_finance.account held only the accounts the MVP posted to. Firms would otherwise create
-- standard TT133 accounts (1121, 3383, 4212 ...) as their own sub-accounts, and a later migration adding the real code
-- would fail at account_guard below. Source: Circular 133/2016/TT-BTC (26 August 2016), Appendix 1 "Danh mục hệ thống
-- tài khoản kế toán áp dụng cho doanh nghiệp nhỏ và vừa", as published by the Ministry of Finance
-- (https://vbpq.mof.gov.vn/DKC.FileManagement/FileStorage/File/19990, pages 1 to 5): all 49 level-1 accounts, every
-- level-2 account, and the level-3 accounts the appendix lists (33311, 33312, 33381, 33382). Codes are as printed; the
-- names follow the appendix. Accounts already present keep their row (ON CONFLICT DO NOTHING): codes never change,
-- and names already shown to users stay as they are. An account's type and normal balance follow its class (the
-- first digit), as in the appendix.
INSERT INTO crove_finance.account (code, name, parent_code) VALUES
  ('111', 'Tiền mặt', NULL),
  ('1111', 'Tiền Việt Nam', '111'),
  ('1112', 'Ngoại tệ', '111'),
  ('112', 'Tiền gửi Ngân hàng', NULL),
  ('1121', 'Tiền Việt Nam', '112'),
  ('1122', 'Ngoại tệ', '112'),
  ('121', 'Chứng khoán kinh doanh', NULL),
  ('128', 'Đầu tư nắm giữ đến ngày đáo hạn', NULL),
  ('1281', 'Tiền gửi có kỳ hạn', '128'),
  ('1288', 'Các khoản đầu tư khác nắm giữ đến ngày đáo hạn', '128'),
  ('131', 'Phải thu của khách hàng', NULL),
  ('133', 'Thuế GTGT được khấu trừ', NULL),
  ('1331', 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', '133'),
  ('1332', 'Thuế GTGT được khấu trừ của TSCĐ', '133'),
  ('136', 'Phải thu nội bộ', NULL),
  ('1361', 'Vốn kinh doanh ở đơn vị trực thuộc', '136'),
  ('1368', 'Phải thu nội bộ khác', '136'),
  ('138', 'Phải thu khác', NULL),
  ('1381', 'Tài sản thiếu chờ xử lý', '138'),
  ('1386', 'Cầm cố, thế chấp, ký quỹ, ký cược', '138'),
  ('1388', 'Phải thu khác', '138'),
  ('141', 'Tạm ứng', NULL),
  ('151', 'Hàng mua đang đi đường', NULL),
  ('152', 'Nguyên liệu, vật liệu', NULL),
  ('153', 'Công cụ, dụng cụ', NULL),
  ('154', 'Chi phí sản xuất, kinh doanh dở dang', NULL),
  ('155', 'Thành phẩm', NULL),
  ('156', 'Hàng hóa', NULL),
  ('157', 'Hàng gửi đi bán', NULL),
  ('211', 'Tài sản cố định', NULL),
  ('2111', 'TSCĐ hữu hình', '211'),
  ('2112', 'TSCĐ thuê tài chính', '211'),
  ('2113', 'TSCĐ vô hình', '211'),
  ('214', 'Hao mòn tài sản cố định', NULL),
  ('2141', 'Hao mòn TSCĐ hữu hình', '214'),
  ('2142', 'Hao mòn TSCĐ thuê tài chính', '214'),
  ('2143', 'Hao mòn TSCĐ vô hình', '214'),
  ('2147', 'Hao mòn bất động sản đầu tư', '214'),
  ('217', 'Bất động sản đầu tư', NULL),
  ('228', 'Đầu tư góp vốn vào đơn vị khác', NULL),
  ('2281', 'Đầu tư vào công ty liên doanh, liên kết', '228'),
  ('2288', 'Đầu tư khác', '228'),
  ('229', 'Dự phòng tổn thất tài sản', NULL),
  ('2291', 'Dự phòng giảm giá chứng khoán kinh doanh', '229'),
  ('2292', 'Dự phòng tổn thất đầu tư vào đơn vị khác', '229'),
  ('2293', 'Dự phòng phải thu khó đòi', '229'),
  ('2294', 'Dự phòng giảm giá hàng tồn kho', '229'),
  ('241', 'Xây dựng cơ bản dở dang', NULL),
  ('2411', 'Mua sắm TSCĐ', '241'),
  ('2412', 'Xây dựng cơ bản', '241'),
  ('2413', 'Sửa chữa lớn TSCĐ', '241'),
  ('242', 'Chi phí trả trước', NULL),
  ('331', 'Phải trả cho người bán', NULL),
  ('333', 'Thuế và các khoản phải nộp Nhà nước', NULL),
  ('3331', 'Thuế giá trị gia tăng phải nộp', '333'),
  ('33311', 'Thuế GTGT đầu ra', '3331'),
  ('33312', 'Thuế GTGT hàng nhập khẩu', '3331'),
  ('3332', 'Thuế tiêu thụ đặc biệt', '333'),
  ('3333', 'Thuế xuất, nhập khẩu', '333'),
  ('3334', 'Thuế thu nhập doanh nghiệp', '333'),
  ('3335', 'Thuế thu nhập cá nhân', '333'),
  ('3336', 'Thuế tài nguyên', '333'),
  ('3337', 'Thuế nhà đất, tiền thuê đất', '333'),
  ('3338', 'Thuế bảo vệ môi trường và các loại thuế khác', '333'),
  ('33381', 'Thuế bảo vệ môi trường', '3338'),
  ('33382', 'Các loại thuế khác', '3338'),
  ('3339', 'Phí, lệ phí và các khoản phải nộp khác', '333'),
  ('334', 'Phải trả người lao động', NULL),
  ('335', 'Chi phí phải trả', NULL),
  ('336', 'Phải trả nội bộ', NULL),
  ('3361', 'Phải trả nội bộ về vốn kinh doanh', '336'),
  ('3368', 'Phải trả nội bộ khác', '336'),
  ('338', 'Phải trả, phải nộp khác', NULL),
  ('3381', 'Tài sản thừa chờ giải quyết', '338'),
  ('3382', 'Kinh phí công đoàn', '338'),
  ('3383', 'Bảo hiểm xã hội', '338'),
  ('3384', 'Bảo hiểm y tế', '338'),
  ('3385', 'Bảo hiểm thất nghiệp', '338'),
  ('3386', 'Nhận ký quỹ, ký cược', '338'),
  ('3387', 'Doanh thu chưa thực hiện', '338'),
  ('3388', 'Phải trả, phải nộp khác', '338'),
  ('341', 'Vay và nợ thuê tài chính', NULL),
  ('3411', 'Các khoản đi vay', '341'),
  ('3412', 'Nợ thuê tài chính', '341'),
  ('352', 'Dự phòng phải trả', NULL),
  ('3521', 'Dự phòng bảo hành sản phẩm hàng hóa', '352'),
  ('3522', 'Dự phòng bảo hành công trình xây dựng', '352'),
  ('3524', 'Dự phòng phải trả khác', '352'),
  ('353', 'Quỹ khen thưởng phúc lợi', NULL),
  ('3531', 'Quỹ khen thưởng', '353'),
  ('3532', 'Quỹ phúc lợi', '353'),
  ('3533', 'Quỹ phúc lợi đã hình thành TSCĐ', '353'),
  ('3534', 'Quỹ thưởng ban quản lý điều hành công ty', '353'),
  ('356', 'Quỹ phát triển khoa học và công nghệ', NULL),
  ('3561', 'Quỹ phát triển khoa học và công nghệ', '356'),
  ('3562', 'Quỹ phát triển khoa học và công nghệ đã hình thành TSCĐ', '356'),
  ('411', 'Vốn đầu tư của chủ sở hữu', NULL),
  ('4111', 'Vốn góp của chủ sở hữu', '411'),
  ('4112', 'Thặng dư vốn cổ phần', '411'),
  ('4118', 'Vốn khác', '411'),
  ('413', 'Chênh lệch tỷ giá hối đoái', NULL),
  ('418', 'Các quỹ thuộc vốn chủ sở hữu', NULL),
  ('419', 'Cổ phiếu quỹ', NULL),
  ('421', 'Lợi nhuận sau thuế chưa phân phối', NULL),
  ('4211', 'Lợi nhuận sau thuế chưa phân phối năm trước', '421'),
  ('4212', 'Lợi nhuận sau thuế chưa phân phối năm nay', '421'),
  ('511', 'Doanh thu bán hàng và cung cấp dịch vụ', NULL),
  ('5111', 'Doanh thu bán hàng hóa', '511'),
  ('5112', 'Doanh thu bán thành phẩm', '511'),
  ('5113', 'Doanh thu cung cấp dịch vụ', '511'),
  ('5118', 'Doanh thu khác', '511'),
  ('515', 'Doanh thu hoạt động tài chính', NULL),
  ('611', 'Mua hàng', NULL),
  ('631', 'Giá thành sản xuất', NULL),
  ('632', 'Giá vốn hàng bán', NULL),
  ('635', 'Chi phí tài chính', NULL),
  ('642', 'Chi phí quản lý kinh doanh', NULL),
  ('6421', 'Chi phí bán hàng', '642'),
  ('6422', 'Chi phí quản lý doanh nghiệp', '642'),
  ('711', 'Thu nhập khác', NULL),
  ('811', 'Chi phí khác', NULL),
  ('821', 'Chi phí thuế thu nhập doanh nghiệp', NULL),
  ('911', 'Xác định kết quả kinh doanh', NULL)
ON CONFLICT (code) DO NOTHING;

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
-- Insert: the parent exists (a TT133 account, or an active digit-only sub-account of the same org, read FOR SHARE so
-- it cannot be deactivated before this commits), the code extends the parent's code by digits or by a dot and a tag,
-- no TT133 account has the code, no account between the parent and the code exists (a digit code goes under the most
-- detailed account it extends), and root_code is the parent's TT133 root. Runs as the caller, so a parent the caller
-- cannot see counts as missing.
CREATE OR REPLACE FUNCTION crove_finance.org_account_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_root text;
  v_suffix text;
  v_deeper text;
BEGIN
  IF EXISTS (SELECT 1 FROM crove_finance.account a WHERE a.code = NEW.code) THEN
    RAISE EXCEPTION 'account % is a TT133 account; a sub-account needs a code of its own', NEW.code USING ERRCODE = '23505';
  END IF;
  SELECT a.code INTO v_root FROM crove_finance.account a WHERE a.code = NEW.parent_code;
  IF NOT FOUND THEN
    SELECT p.root_code INTO v_root
    FROM crove_finance.org_account p
    WHERE p.org_id = NEW.org_id AND p.code = NEW.parent_code AND p.active AND p.code !~ '\.'
    FOR SHARE;
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
  SELECT x.code INTO v_deeper FROM (
    SELECT a.code FROM crove_finance.account a
    UNION ALL
    SELECT o.code FROM crove_finance.org_account o WHERE o.org_id = NEW.org_id AND o.code !~ '\.'
  ) x
  WHERE pg_catalog.length(x.code) > pg_catalog.length(NEW.parent_code) AND pg_catalog.length(x.code) < pg_catalog.length(NEW.code)
    AND pg_catalog.left(NEW.code, pg_catalog.length(x.code)) = x.code
  ORDER BY pg_catalog.length(x.code) DESC
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'sub-account % must go under account %, the most detailed account its code extends', NEW.code, v_deeper
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
-- reactivating is refused while its parent sub-account is inactive (read FOR SHARE, so the parent cannot be
-- deactivated meanwhile). The lock on the row this update takes is what the vendor default check and a new child's
-- insert wait for, so neither passes alongside a deactivation.
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
    PERFORM 1 FROM crove_finance.org_account p WHERE p.org_id = OLD.org_id AND p.code = OLD.parent_code FOR SHARE;
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
