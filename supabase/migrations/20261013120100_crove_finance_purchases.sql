-- Crove finance (MVP): TT133 chart of accounts, purchase documents, journal entries that always balance,
-- and per-vendor learned debit accounts. Idempotent.

-- Money domains (ADR-0021 sizes).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'crove_finance' AND t.typname = 'amount') THEN
    CREATE DOMAIN crove_finance.amount AS numeric(20, 4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'crove_finance' AND t.typname = 'unit_amount') THEN
    CREATE DOMAIN crove_finance.unit_amount AS numeric(24, 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'crove_finance' AND t.typname = 'quantity') THEN
    CREATE DOMAIN crove_finance.quantity AS numeric(20, 6);
  END IF;
END $$;
GRANT USAGE ON TYPE crove_finance.amount, crove_finance.unit_amount, crove_finance.quantity TO crove_tenant;

-- Global reference table (no org_id): TT133/2016 chart of accounts used by the MVP.
CREATE TABLE IF NOT EXISTS crove_finance.account (
  code text PRIMARY KEY CHECK (code ~ '^[0-9]{3,5}$'),
  name text NOT NULL,
  parent_code text REFERENCES crove_finance.account (code),
  standard text NOT NULL DEFAULT 'TT133'
);
REVOKE ALL ON crove_finance.account FROM PUBLIC;
GRANT SELECT ON crove_finance.account TO crove_tenant;

INSERT INTO crove_finance.account (code, name, parent_code) VALUES
  ('111', 'Tiền mặt', NULL),
  ('112', 'Tiền gửi ngân hàng', NULL),
  ('131', 'Phải thu của khách hàng', NULL),
  ('133', 'Thuế GTGT được khấu trừ', NULL),
  ('1331', 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', '133'),
  ('1332', 'Thuế GTGT được khấu trừ của TSCĐ', '133'),
  ('141', 'Tạm ứng', NULL),
  ('152', 'Nguyên liệu, vật liệu', NULL),
  ('153', 'Công cụ, dụng cụ', NULL),
  ('154', 'Chi phí sản xuất, kinh doanh dở dang', NULL),
  ('155', 'Thành phẩm', NULL),
  ('156', 'Hàng hóa', NULL),
  ('211', 'Tài sản cố định', NULL),
  ('214', 'Hao mòn tài sản cố định', NULL),
  ('242', 'Chi phí trả trước', NULL),
  ('331', 'Phải trả cho người bán', NULL),
  ('333', 'Thuế và các khoản phải nộp Nhà nước', NULL),
  ('3331', 'Thuế giá trị gia tăng phải nộp', '333'),
  ('334', 'Phải trả người lao động', NULL),
  ('338', 'Phải trả, phải nộp khác', NULL),
  ('411', 'Vốn đầu tư của chủ sở hữu', NULL),
  ('421', 'Lợi nhuận sau thuế chưa phân phối', NULL),
  ('511', 'Doanh thu bán hàng và cung cấp dịch vụ', NULL),
  ('515', 'Doanh thu hoạt động tài chính', NULL),
  ('632', 'Giá vốn hàng bán', NULL),
  ('635', 'Chi phí tài chính', NULL),
  ('642', 'Chi phí quản lý kinh doanh', NULL),
  ('6421', 'Chi phí bán hàng', '642'),
  ('6422', 'Chi phí quản lý doanh nghiệp', '642'),
  ('711', 'Thu nhập khác', NULL),
  ('811', 'Chi phí khác', NULL),
  ('821', 'Chi phí thuế thu nhập doanh nghiệp', NULL),
  ('911', 'Xác định kết quả kinh doanh', NULL)
ON CONFLICT (code) DO UPDATE SET name = excluded.name, parent_code = excluded.parent_code;

CREATE TABLE IF NOT EXISTS crove_finance.purchase_document (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  party_id uuid NOT NULL,
  invoice_series text NOT NULL DEFAULT '',
  invoice_number text NOT NULL,
  invoice_date date NOT NULL,
  currency text NOT NULL DEFAULT 'VND',
  subtotal crove_finance.amount NOT NULL,
  vat_amount crove_finance.amount NOT NULL,
  total crove_finance.amount NOT NULL,
  payment_method text,
  tax_authority_code text,
  source_file_id uuid,
  proposal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, party_id, invoice_series, invoice_number),
  FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id),
  CHECK (total = subtotal + vat_amount)
);
CREATE INDEX IF NOT EXISTS purchase_document_date_idx ON crove_finance.purchase_document (org_id, invoice_date DESC);
SELECT crove_kernel.apply_tenant_rls('crove_finance.purchase_document');

CREATE TABLE IF NOT EXISTS crove_finance.purchase_line (
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  description text NOT NULL,
  unit text,
  quantity crove_finance.quantity,
  unit_price crove_finance.unit_amount,
  amount crove_finance.amount NOT NULL,
  vat_rate text,
  vat_amount crove_finance.amount NOT NULL DEFAULT 0,
  debit_account text NOT NULL REFERENCES crove_finance.account (code),
  PRIMARY KEY (org_id, document_id, line_no),
  FOREIGN KEY (org_id, document_id) REFERENCES crove_finance.purchase_document (org_id, id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.purchase_line');

CREATE TABLE IF NOT EXISTS crove_finance.journal_entry (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  entry_date date NOT NULL,
  description text NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS journal_entry_date_idx ON crove_finance.journal_entry (org_id, entry_date DESC);
SELECT crove_kernel.apply_tenant_rls('crove_finance.journal_entry');

CREATE TABLE IF NOT EXISTS crove_finance.journal_line (
  org_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_no int NOT NULL CHECK (line_no > 0),
  account_code text NOT NULL REFERENCES crove_finance.account (code),
  debit crove_finance.amount NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit crove_finance.amount NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_id uuid,
  memo text,
  PRIMARY KEY (org_id, entry_id, line_no),
  FOREIGN KEY (org_id, entry_id) REFERENCES crove_finance.journal_entry (org_id, id) ON DELETE CASCADE,
  CHECK ((debit = 0) <> (credit = 0))
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.journal_line');

-- Every journal entry must balance at commit time.
CREATE OR REPLACE FUNCTION crove_finance.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_org uuid := coalesce(NEW.org_id, OLD.org_id);
  v_entry uuid := coalesce(NEW.entry_id, OLD.entry_id);
  v_diff numeric;
  v_lines int;
BEGIN
  SELECT coalesce(sum(debit), 0) - coalesce(sum(credit), 0), count(*) INTO v_diff, v_lines
  FROM crove_finance.journal_line WHERE org_id = v_org AND entry_id = v_entry;
  IF v_lines > 0 AND (v_diff <> 0 OR v_lines < 2) THEN
    RAISE EXCEPTION 'journal entry % does not balance (difference %)', v_entry, v_diff USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_line_balanced ON crove_finance.journal_line;
CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT OR UPDATE OR DELETE ON crove_finance.journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION crove_finance.check_entry_balanced();

-- Debit account last confirmed by a human for a vendor; applied before keyword heuristics.
CREATE TABLE IF NOT EXISTS crove_finance.vendor_account_rule (
  org_id uuid NOT NULL,
  party_id uuid NOT NULL,
  debit_account text NOT NULL REFERENCES crove_finance.account (code),
  confirmed_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, party_id),
  FOREIGN KEY (org_id, party_id) REFERENCES crove_kernel.party (org_id, id) ON DELETE CASCADE
);
SELECT crove_kernel.apply_tenant_rls('crove_finance.vendor_account_rule');

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crove_finance FROM PUBLIC;
