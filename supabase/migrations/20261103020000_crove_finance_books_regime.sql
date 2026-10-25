-- Crove finance (issue #1403; plan Phase 2a "legal_entity_books TT133/TT99 v2026.1"): the accounting regime of each
-- legal entity's books, and the chart of accounts of Circular 99/2025/TT-BTC. Idempotent; applied files stay untouched.
--
-- crove_finance.chart              the charts of accounts Crove knows, global: (regime, version). Two today:
--                                  ('tt133', '2026.1'), Circular 133/2016/TT-BTC for small and medium enterprises, and
--                                  ('tt99', '2026.1'), Circular 99/2025/TT-BTC, which replaces Circular 200/2014 for
--                                  fiscal years from 1 January 2026. A version, not just a regime: a draft replacing
--                                  Circular 133 (October 2026) cuts its chart from 49 to 22 accounts, so TT133 books
--                                  will have a second version too.
-- crove_finance.chart_account      the accounts of every chart but TT133 2026.1, global and read-only for every org.
--                                  TT133 2026.1 stays crove_finance.account, which every posting, report and the org's
--                                  sub-accounts (crove_finance.org_account) already name; a CHECK keeps a second copy of
--                                  it out of this table. Codes are never deleted or renumbered (names may be corrected),
--                                  as for crove_finance.account.
-- crove_finance.legal_entity_books one row per (org, legal entity, effective_from): from that date on, the entity keeps
--                                  its books under that chart. effective_from is the first day of one of the org's fiscal
--                                  years (crove_kernel.tax_profile.fiscal_year_end_month, December when the org has no
--                                  profile). An entity with no row on a date keeps TT133 2026.1 books, the only regime
--                                  before this file, so nothing is backfilled and every entity on main is unchanged.
--                                  A row is written, changed or removed only when no journal entry of the entity would
--                                  fall under another chart by it, so the chart of booked years never changes (a row
--                                  that repeats the chart in force, such as TT133 2026.1 over TT133 years, changes
--                                  nothing and is accepted). Per legal
--                                  entity like every finance table (b_legal_entity, RESTRICTIVE le_scope); crove_tenant
--                                  only reads it: the command and the screen that choose a regime come with the TT99
--                                  posting templates (#1403 phase B, with the accountant, #61), so until then only a
--                                  migration or the database owner writes a row.
--
-- Postings follow the regime (crove_finance.check_account_ref, the trigger journal_line_account_ref): a journal line of
-- an entity whose books on the entry's date are not TT133 2026.1 must name an account of that chart. The org's
-- sub-accounts all roll up to TT133 accounts, so they are refused there until phase B gives each regime its own
-- sub-accounts. The accounts documents name before they are posted (purchase and sales document lines, a statement's
-- bank account, vendor defaults, learned rules) keep their checks against the org's TT133 chart until the TT99 posting
-- templates exist; the journal line is where a posting meets the books. A reversal posts on the reversed entry's
-- accounts: one that lands in a fiscal year under another chart is refused, as it should be (the transition maps
-- balances to the new chart, phase B).
--
-- Races. Every journal entry reads its entity's crove_finance.period_lock row FOR SHARE (or FOR UPDATE for an opening
-- entry) before it is written (20261102150000). The books guard locks the same row FOR UPDATE before it looks for
-- entries, so a posting in flight finishes first and is seen, and a posting that starts later waits for the books row
-- to commit and is checked against it.
--
-- The TT99 accounts. Source: Circular 99/2025/TT-BTC, Appendix II "Hệ thống tài khoản kế toán", part A
-- "Danh mục hệ thống tài khoản kế toán", as reproduced by sovatax.com and cross-checked with two other reproductions
-- for accounts 111 to 411: 184 accounts (71 level 1, 101 level 2, 10 level 3, 2 level 4), the totals the official text
-- gives. Codes are as printed and each account's parent is the longest code of the list its code extends. No entity can
-- keep TT99 books before an accountant has checked this list together with the posting templates (#61, phase B); a
-- correction then is a later migration that renames an account (its code stays).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The charts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.chart (
  regime text NOT NULL CHECK (regime IN ('tt133', 'tt99')),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}\.[0-9]+$'),
  -- The legal text the chart comes from.
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  PRIMARY KEY (regime, version)
);
REVOKE ALL ON crove_finance.chart FROM PUBLIC, crove_tenant;
GRANT SELECT ON crove_finance.chart TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_finance.chart');

INSERT INTO crove_finance.chart (regime, version, name) VALUES
  ('tt133', '2026.1', 'Thông tư 133/2016/TT-BTC'),
  ('tt99', '2026.1', 'Thông tư 99/2025/TT-BTC')
ON CONFLICT (regime, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS crove_finance.chart_account (
  regime text NOT NULL,
  version text NOT NULL,
  code text NOT NULL CHECK (code ~ '^[0-9]{3,6}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  parent_code text,
  PRIMARY KEY (regime, version, code),
  CONSTRAINT chart_account_chart_fk FOREIGN KEY (regime, version) REFERENCES crove_finance.chart (regime, version),
  CONSTRAINT chart_account_parent_fk FOREIGN KEY (regime, version, parent_code) REFERENCES crove_finance.chart_account (regime, version, code),
  -- A child's code extends its parent's (the roll-up by code prefix of B01 and B02 relies on it).
  CONSTRAINT chart_account_parent_prefix CHECK (parent_code IS NULL OR (char_length(code) > char_length(parent_code) AND starts_with(code, parent_code))),
  -- TT133 2026.1 is crove_finance.account; no second copy of it.
  CONSTRAINT chart_account_not_tt133_2026 CHECK (NOT (regime = 'tt133' AND version = '2026.1'))
);
REVOKE ALL ON crove_finance.chart_account FROM PUBLIC, crove_tenant;
GRANT SELECT ON crove_finance.chart_account TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_finance.chart_account');

-- Codes are never deleted or renumbered (names may be corrected), so a code written into the ledger always resolves to
-- the same account. TRUNCATE is refused by crove_finance.reject_account_delete, as on crove_finance.account.
CREATE OR REPLACE FUNCTION crove_finance.chart_account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.regime = OLD.regime AND NEW.version = OLD.version AND NEW.code = OLD.code
     AND NEW.parent_code IS NOT DISTINCT FROM OLD.parent_code THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chart account codes are never deleted or changed (% % account %)', OLD.regime, OLD.version, OLD.code
    USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION crove_finance.chart_account_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS chart_account_guard ON crove_finance.chart_account;
CREATE TRIGGER chart_account_guard
  BEFORE UPDATE OR DELETE ON crove_finance.chart_account
  FOR EACH ROW EXECUTE FUNCTION crove_finance.chart_account_guard();
DROP TRIGGER IF EXISTS chart_account_no_truncate ON crove_finance.chart_account;
CREATE TRIGGER chart_account_no_truncate
  BEFORE TRUNCATE ON crove_finance.chart_account
  FOR EACH STATEMENT EXECUTE FUNCTION crove_finance.reject_account_delete();

-- Parents before their children (the list is in code order, so every parent comes first).
INSERT INTO crove_finance.chart_account (regime, version, code, name, parent_code)
SELECT 'tt99', '2026.1', v.code, v.name, v.parent_code FROM (VALUES
  ('111', 'Tiền mặt', NULL),
  ('112', 'Tiền gửi không kỳ hạn', NULL),
  ('113', 'Tiền đang chuyển', NULL),
  ('121', 'Chứng khoán kinh doanh', NULL),
  ('128', 'Đầu tư nắm giữ đến ngày đáo hạn', NULL),
  ('1281', 'Tiền gửi có kỳ hạn', '128'),
  ('1282', 'Trái phiếu', '128'),
  ('1283', 'Cho vay', '128'),
  ('1288', 'Các khoản đầu tư khác nắm giữ đến ngày đáo hạn', '128'),
  ('131', 'Phải thu của khách hàng', NULL),
  ('133', 'Thuế GTGT được khấu trừ', NULL),
  ('1331', 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', '133'),
  ('1332', 'Thuế GTGT được khấu trừ của TSCĐ', '133'),
  ('136', 'Phải thu nội bộ', NULL),
  ('1361', 'Vốn kinh doanh ở đơn vị trực thuộc', '136'),
  ('1362', 'Phải thu nội bộ về chênh lệch tỷ giá', '136'),
  ('1363', 'Phải thu nội bộ về chi phí đi vay đủ điều kiện được vốn hoá', '136'),
  ('1368', 'Phải thu nội bộ khác', '136'),
  ('138', 'Phải thu khác', NULL),
  ('1381', 'Tài sản thiếu chờ xử lý', '138'),
  ('1383', 'Thuế TTĐB của hàng nhập khẩu', '138'),
  ('1388', 'Phải thu khác', '138'),
  ('141', 'Tạm ứng', NULL),
  ('151', 'Hàng mua đang đi đường', NULL),
  ('152', 'Nguyên liệu, vật liệu', NULL),
  ('153', 'Công cụ, dụng cụ', NULL),
  ('154', 'Chi phí sản xuất, kinh doanh dở dang', NULL),
  ('155', 'Sản phẩm', NULL),
  ('156', 'Hàng hóa', NULL),
  ('157', 'Hàng gửi đi bán', NULL),
  ('158', 'Nguyên liệu, vật tư tại kho bảo thuế', NULL),
  ('171', 'Giao dịch mua, bán lại trái phiếu chính phủ', NULL),
  ('211', 'Tài sản cố định hữu hình', NULL),
  ('212', 'Tài sản cố định thuê tài chính', NULL),
  ('213', 'Tài sản cố định vô hình', NULL),
  ('214', 'Hao mòn tài sản cố định', NULL),
  ('2141', 'Hao mòn TSCĐ hữu hình', '214'),
  ('2142', 'Hao mòn TSCĐ thuê tài chính', '214'),
  ('2143', 'Hao mòn TSCĐ vô hình', '214'),
  ('2147', 'Hao mòn BĐSĐT', '214'),
  ('215', 'Tài sản sinh học', NULL),
  ('2151', 'Súc vật nuôi cho sản phẩm định kỳ', '215'),
  ('21511', 'Súc vật nuôi cho sản phẩm định kỳ chưa đạt đến giai đoạn trưởng thành', '2151'),
  ('21512', 'Súc vật nuôi cho sản phẩm định kỳ đạt đến giai đoạn trưởng thành', '2151'),
  ('215121', 'Nguyên giá', '21512'),
  ('215122', 'Giá trị khấu hao lũy kế', '21512'),
  ('2152', 'Súc vật nuôi lấy sản phẩm một lần', '215'),
  ('2153', 'Cây trồng theo mùa vụ hoặc lấy sản phẩm một lần', '215'),
  ('217', 'Bất động sản đầu tư', NULL),
  ('221', 'Đầu tư vào công ty con', NULL),
  ('222', 'Đầu tư vào công ty liên doanh, liên kết', NULL),
  ('228', 'Đầu tư khác', NULL),
  ('2281', 'Đầu tư góp vốn vào đơn vị khác', '228'),
  ('2288', 'Đầu tư khác', '228'),
  ('229', 'Dự phòng tổn thất tài sản', NULL),
  ('2291', 'Dự phòng giảm giá chứng khoán kinh doanh', '229'),
  ('2292', 'Dự phòng tổn thất đầu tư vào đơn vị khác', '229'),
  ('2293', 'Dự phòng phải thu khó đòi', '229'),
  ('2294', 'Dự phòng giảm giá hàng tồn kho', '229'),
  ('2295', 'Dự phòng tổn thất tài sản sinh học', '229'),
  ('241', 'Xây dựng cơ bản dở dang', NULL),
  ('2411', 'Mua sắm TSCĐ', '241'),
  ('2412', 'Xây dựng cơ bản', '241'),
  ('2413', 'Sửa chữa, bảo dưỡng định kỳ TSCĐ', '241'),
  ('2414', 'Nâng cấp, cải tạo TSCĐ', '241'),
  ('242', 'Chi phí chờ phân bổ', NULL),
  ('243', 'Tài sản thuế thu nhập hoãn lại', NULL),
  ('244', 'Ký quỹ, ký cược', NULL),
  ('331', 'Phải trả cho người bán', NULL),
  ('332', 'Phải trả cổ tức, lợi nhuận', NULL),
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
  ('3362', 'Phải trả nội bộ về chênh lệch tỷ giá', '336'),
  ('3363', 'Phải trả nội bộ về chi phí đi vay đủ điều kiện được vốn hóa', '336'),
  ('3368', 'Phải trả nội bộ khác', '336'),
  ('337', 'Thanh toán theo tiến độ hợp đồng xây dựng', NULL),
  ('338', 'Phải trả, phải nộp khác', NULL),
  ('3381', 'Tài sản thừa chờ giải quyết', '338'),
  ('3382', 'Kinh phí công đoàn', '338'),
  ('3383', 'Bảo hiểm xã hội', '338'),
  ('3384', 'Bảo hiểm y tế', '338'),
  ('3386', 'Bảo hiểm thất nghiệp', '338'),
  ('3387', 'Doanh thu chờ phân bổ', '338'),
  ('3388', 'Phải trả, phải nộp khác', '338'),
  ('341', 'Vay và nợ thuê tài chính', NULL),
  ('3411', 'Các khoản đi vay', '341'),
  ('3412', 'Nợ thuê tài chính', '341'),
  ('343', 'Trái phiếu phát hành', NULL),
  ('3431', 'Trái phiếu thường', '343'),
  ('3432', 'Trái phiếu chuyển đổi', '343'),
  ('344', 'Nhận ký quỹ, ký cược', NULL),
  ('347', 'Thuế thu nhập hoãn lại phải trả', NULL),
  ('352', 'Dự phòng phải trả', NULL),
  ('3521', 'Dự phòng bảo hành sản phẩm, hàng hóa', '352'),
  ('3522', 'Dự phòng bảo hành công trình xây dựng', '352'),
  ('3523', 'Dự phòng tái cơ cấu doanh nghiệp', '352'),
  ('3525', 'Dự phòng phải trả khác', '352'),
  ('353', 'Quỹ khen thưởng, phúc lợi', NULL),
  ('3531', 'Quỹ khen thưởng', '353'),
  ('3532', 'Quỹ phúc lợi', '353'),
  ('3533', 'Quỹ phúc lợi đã hình thành TSCĐ', '353'),
  ('3534', 'Quỹ thưởng ban quản lý điều hành công ty', '353'),
  ('356', 'Quỹ phát triển khoa học và công nghệ', NULL),
  ('3561', 'Quỹ phát triển khoa học và công nghệ', '356'),
  ('3562', 'Quỹ phát triển khoa học và công nghệ đã hình thành tài sản', '356'),
  ('357', 'Quỹ bình ổn giá', NULL),
  ('411', 'Vốn đầu tư của chủ sở hữu', NULL),
  ('4111', 'Vốn góp của chủ sở hữu', '411'),
  ('41111', 'Cổ phiếu phổ thông có quyền biểu quyết', '4111'),
  ('41112', 'Cổ phiếu ưu đãi', '4111'),
  ('4112', 'Thặng dư vốn', '411'),
  ('4113', 'Quyền chọn chuyển đổi trái phiếu', '411'),
  ('4118', 'Vốn khác', '411'),
  ('412', 'Chênh lệch đánh giá lại tài sản', NULL),
  ('413', 'Chênh lệch tỷ giá hối đoái', NULL),
  ('414', 'Quỹ đầu tư phát triển', NULL),
  ('418', 'Các quỹ khác thuộc vốn chủ sở hữu', NULL),
  ('419', 'Cổ phiếu mua lại của chính mình', NULL),
  ('421', 'Lợi nhuận sau thuế chưa phân phối', NULL),
  ('4211', 'Lợi nhuận sau thuế chưa phân phối lũy kế đến cuối năm trước', '421'),
  ('4212', 'Lợi nhuận sau thuế chưa phân phối năm nay', '421'),
  ('511', 'Doanh thu bán hàng và cung cấp dịch vụ', NULL),
  ('515', 'Doanh thu hoạt động tài chính', NULL),
  ('521', 'Các khoản giảm trừ doanh thu', NULL),
  ('621', 'Chi phí nguyên liệu, vật liệu trực tiếp', NULL),
  ('622', 'Chi phí nhân công trực tiếp', NULL),
  ('623', 'Chi phí sử dụng máy thi công', NULL),
  ('6231', 'Chi phí nhân công', '623'),
  ('6232', 'Chi phí vật liệu', '623'),
  ('6233', 'Chi phí dụng cụ sản xuất', '623'),
  ('6234', 'Chi phí khấu hao máy thi công', '623'),
  ('6237', 'Chi phí dịch vụ mua ngoài', '623'),
  ('6238', 'Chi phí bằng tiền khác', '623'),
  ('627', 'Chi phí sản xuất chung', NULL),
  ('6271', 'Chi phí nhân viên phân xưởng', '627'),
  ('6272', 'Chi phí vật liệu', '627'),
  ('6273', 'Chi phí dụng cụ sản xuất', '627'),
  ('6274', 'Chi phí khấu hao TSCĐ', '627'),
  ('6275', 'Thuế, phí, lệ phí', '627'),
  ('6277', 'Chi phí dịch vụ mua ngoài', '627'),
  ('6278', 'Chi phí bằng tiền khác', '627'),
  ('632', 'Giá vốn hàng bán', NULL),
  ('635', 'Chi phí tài chính', NULL),
  ('641', 'Chi phí bán hàng', NULL),
  ('6411', 'Chi phí nhân viên', '641'),
  ('6412', 'Chi phí vật liệu, bao bì', '641'),
  ('6413', 'Chi phí dụng cụ, đồ dùng', '641'),
  ('6414', 'Chi phí khấu hao TSCĐ', '641'),
  ('6415', 'Thuế, phí, lệ phí', '641'),
  ('6417', 'Chi phí dịch vụ mua ngoài', '641'),
  ('6418', 'Chi phí bằng tiền khác', '641'),
  ('642', 'Chi phí quản lý doanh nghiệp', NULL),
  ('6421', 'Chi phí nhân viên quản lý', '642'),
  ('6422', 'Chi phí vật liệu quản lý', '642'),
  ('6423', 'Chi phí đồ dùng văn phòng', '642'),
  ('6424', 'Chi phí khấu hao TSCĐ', '642'),
  ('6425', 'Thuế, phí và lệ phí', '642'),
  ('6426', 'Chi phí dự phòng', '642'),
  ('6427', 'Chi phí dịch vụ mua ngoài', '642'),
  ('6428', 'Chi phí bằng tiền khác', '642'),
  ('711', 'Thu nhập khác', NULL),
  ('811', 'Chi phí khác', NULL),
  ('821', 'Chi phí thuế thu nhập doanh nghiệp', NULL),
  ('8211', 'Chi phí thuế TNDN hiện hành', '821'),
  ('82111', 'Chi phí thuế thu nhập doanh nghiệp hiện hành theo quy định của Luật thuế thu nhập doanh nghiệp', '8211'),
  ('82112', 'Chi phí thuế thu nhập doanh nghiệp bổ sung theo quy định về thuế tối thiểu toàn cầu', '8211'),
  ('8212', 'Chi phí thuế TNDN hoãn lại', '821'),
  ('911', 'Xác định kết quả kinh doanh', NULL)
) AS v (code, name, parent_code)
ON CONFLICT (regime, version, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The regime of each legal entity's books
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.legal_entity_books (
  org_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  regime text NOT NULL,
  chart_version text NOT NULL,
  -- The first day of the fiscal year from which the entity keeps its books under this chart.
  effective_from date NOT NULL CHECK (effective_from = date_trunc('month', effective_from)::date),
  -- Who chose it (NULL for a row a migration wrote).
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  -- One regime per entity and start date; it also backs the entity's foreign key (G3) and the lookup by date.
  CONSTRAINT legal_entity_books_from_uq UNIQUE (org_id, legal_entity_id, effective_from),
  CONSTRAINT legal_entity_books_legal_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT legal_entity_books_chart_fk FOREIGN KEY (regime, chart_version) REFERENCES crove_finance.chart (regime, version)
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.legal_entity_books');
-- Read only for the runtime roles until phase B brings the command that chooses a regime (see the header).
REVOKE INSERT, UPDATE, DELETE ON crove_finance.legal_entity_books FROM crove_tenant;

-- The entity: the one named, or the org's default (crove_finance.legal_entity_fill, no parent), never changed.
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.legal_entity_books;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.legal_entity_books
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.legal_entity_books ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.legal_entity_books;
CREATE POLICY le_scope ON crove_finance.legal_entity_books AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- BEFORE INSERT OR UPDATE OR DELETE, after b_legal_entity (triggers fire in name order). A row starts on the first day
-- of one of the org's fiscal years, and is written, changed or removed only when no journal entry of its entity would
-- fall under another chart by it (BOOKS_REGIME_IN_USE):
--   - an insert or a delete changes the chart of the dates from the row's effective_from to the next row's (or on
--     without one), between the row's chart and the chart in force before it (the previous row's, else TT133 2026.1);
--     when both are the same chart nothing changes;
--   - an update that keeps the date and the chart changes nothing; any other update is refused once the entity has an
--     entry from the earlier of its two dates up to the next other row after the later one (or on without one): the
--     dates whose chart it may change, even when it moves past another row.
-- Runs as the writer, through its own policies: a writer sees the rows and entries of every entity it may write books
-- for.
CREATE OR REPLACE FUNCTION crove_finance.legal_entity_books_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row crove_finance.legal_entity_books := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_end_month smallint;
  v_regime text := 'tt133';
  v_version text := '2026.1';
  v_from date;
  v_to date;
  v_first date;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.effective_from = OLD.effective_from AND NEW.regime = OLD.regime AND NEW.chart_version = OLD.chart_version THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.fiscal_year_end_month INTO v_end_month FROM crove_kernel.tax_profile t WHERE t.org_id = NEW.org_id;
    IF pg_catalog.date_part('month', NEW.effective_from) <> (coalesce(v_end_month, 12) % 12) + 1 THEN
      RAISE EXCEPTION 'BOOKS_NOT_FISCAL_YEAR_START' USING ERRCODE = '23514',
        DETAIL = pg_catalog.json_build_object('effectiveFrom', NEW.effective_from, 'fiscalYearEndMonth', coalesce(v_end_month, 12))::text;
    END IF;
  END IF;
  -- Hold back postings and other books writes of the entity until this commits (see the header): the row every entry
  -- reads before it is written.
  INSERT INTO crove_finance.period_lock (org_id, legal_entity_id) VALUES (v_row.org_id, v_row.legal_entity_id)
    ON CONFLICT (org_id, legal_entity_id) DO NOTHING;
  PERFORM 1 FROM crove_finance.period_lock p WHERE p.org_id = v_row.org_id AND p.legal_entity_id = v_row.legal_entity_id FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    v_from := least(OLD.effective_from, NEW.effective_from);
    SELECT min(b.effective_from) INTO v_to FROM crove_finance.legal_entity_books b
    WHERE b.org_id = v_row.org_id AND b.legal_entity_id = v_row.legal_entity_id AND b.id <> OLD.id
      AND b.effective_from > greatest(OLD.effective_from, NEW.effective_from);
  ELSE
    v_from := v_row.effective_from;
    SELECT b.regime, b.chart_version INTO v_regime, v_version FROM crove_finance.legal_entity_books b
    WHERE b.org_id = v_row.org_id AND b.legal_entity_id = v_row.legal_entity_id AND b.effective_from < v_row.effective_from
    ORDER BY b.effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
      v_regime := 'tt133';
      v_version := '2026.1';
    END IF;
    IF v_regime = v_row.regime AND v_version = v_row.chart_version THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT min(b.effective_from) INTO v_to FROM crove_finance.legal_entity_books b
    WHERE b.org_id = v_row.org_id AND b.legal_entity_id = v_row.legal_entity_id AND b.effective_from > v_row.effective_from;
  END IF;
  SELECT min(e.entry_date) INTO v_first FROM crove_finance.journal_entry e
  WHERE e.org_id = v_row.org_id AND e.legal_entity_id = v_row.legal_entity_id AND e.entry_date >= v_from
    AND (v_to IS NULL OR e.entry_date < v_to);
  IF v_first IS NOT NULL THEN
    RAISE EXCEPTION 'BOOKS_REGIME_IN_USE' USING ERRCODE = '23514',
      DETAIL = pg_catalog.json_build_object('legalEntityId', v_row.legal_entity_id, 'from', v_from, 'firstEntry', v_first)::text;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.legal_entity_books_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS legal_entity_books_guard ON crove_finance.legal_entity_books;
CREATE TRIGGER legal_entity_books_guard
  BEFORE INSERT OR UPDATE OR DELETE ON crove_finance.legal_entity_books
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_books_guard();

-- ---------------------------------------------------------------------------
-- Account references follow the regime
-- ---------------------------------------------------------------------------
-- The body of 20261019150100_crove_finance_sales_documents.sql (the newest) with one change: a journal line first finds the chart of
-- its entry's entity on the entry's date. Not TT133 2026.1: the account must be in that chart (crove_finance.chart_account),
-- and nothing else is accepted (see the header). TT133 2026.1, or no books row: as before. Purchase lines, vendor
-- defaults and learned rules are checked as before.
CREATE OR REPLACE FUNCTION crove_finance.check_account_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_code text;
  v_active boolean;
  v_entity uuid;
  v_regime text;
  v_version text;
BEGIN
  -- Separate statements: an expression naming a column the table does not have fails even in a branch not taken.
  IF TG_TABLE_NAME = 'journal_line' THEN
    v_code := NEW.account_code;
    SELECT e.legal_entity_id, b.regime, b.chart_version INTO v_entity, v_regime, v_version
    FROM crove_finance.journal_entry e
    LEFT JOIN LATERAL (
      SELECT b.regime, b.chart_version FROM crove_finance.legal_entity_books b
      WHERE b.org_id = e.org_id AND b.legal_entity_id = e.legal_entity_id AND b.effective_from <= e.entry_date
      ORDER BY b.effective_from DESC LIMIT 1) b ON true
    WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id;
    IF v_regime IS NOT NULL AND (v_regime, v_version) <> ('tt133', '2026.1') THEN
      IF EXISTS (SELECT 1 FROM crove_finance.chart_account a WHERE a.regime = v_regime AND a.version = v_version AND a.code = v_code) THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'insert or update on table "%" violates foreign key check: account % is not in the % % chart of accounts of legal entity %',
        TG_TABLE_NAME, v_code, v_regime, v_version, v_entity USING ERRCODE = '23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_line' THEN
    v_code := COALESCE(NEW.debit_account, NEW.credit_account);
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
