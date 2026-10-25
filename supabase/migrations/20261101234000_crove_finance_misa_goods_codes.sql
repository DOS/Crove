-- Crove finance (issue #1398): an org's MISA SME item and warehouse codes for stock purchases. Idempotent; applied
-- files stay untouched.
--
-- Purchase lines debited to 152 (materials), 153 (tools) or 156 (goods), or to a sub-account of one, are exported in
-- MISA SME's goods purchase template (Mua_hang_qua_kho_VND.xls), which needs a MISA catalog item code ("Mã hàng (*)")
-- and a warehouse code ("Kho") per line. Crove cannot know a firm's MISA catalog, so each org maps a stock account to
-- the two codes here, one row per account; a sub-account without a row takes its nearest parent's codes, and an account
-- with none takes the built-in defaults (@crove/kernel-contract misa-goods.ts). The codes are labels for the export
-- only: no posting, amount or journal line reads them.
--
-- Owners and admins set and clear rows with finance.misa_goods_code.set and .remove (R1, audited). The row names the
-- account by code, not by a foreign key: the TT133 chart and the org's sub-accounts are two tables, and the command
-- checks the code is in the org's chart. Kept on an org purge like the chart (org_account): it holds no personal data.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.misa_goods_code (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  -- A stock account: 152, 153 or 156, or a sub-account of one (its code starts with its parent's).
  account_code text NOT NULL,
  item_code text NOT NULL,
  -- null: the export leaves "Kho" blank.
  warehouse_code text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT misa_goods_code_account_uq UNIQUE (org_id, account_code),
  CONSTRAINT misa_goods_code_account_format CHECK (account_code ~ '^15[236][0-9]{0,7}(\.[A-Z0-9]{1,20})?$'),
  -- MISA catalog codes: letters, digits and _ . - /, at most 25 characters (MISA_CODE_PATTERN).
  CONSTRAINT misa_goods_code_item_format CHECK (item_code ~ '^[A-Za-z0-9_./-]{1,25}$'),
  CONSTRAINT misa_goods_code_warehouse_format CHECK (warehouse_code IS NULL OR warehouse_code ~ '^[A-Za-z0-9_./-]{1,25}$')
);

SELECT crove_kernel.apply_tenant_rls('crove_finance.misa_goods_code');
-- Tenant roles read, insert and delete; an update changes only the codes and who changed them, never the account.
REVOKE UPDATE ON crove_finance.misa_goods_code FROM crove_tenant;
GRANT UPDATE (item_code, warehouse_code, updated_by, updated_at) ON crove_finance.misa_goods_code TO crove_tenant;
