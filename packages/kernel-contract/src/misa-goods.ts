// MISA SME item and warehouse codes for stock purchases (issue #1398), as pure functions shared by the finance module
// and the SPA. A purchase line debited to a stock account (152 materials, 153 tools, 156 goods, or a sub-account of
// one) goes to MISA's goods purchase template, which needs the MISA catalog code of the item ("Mã hàng (*)") and of the
// warehouse ("Kho"). Crove cannot know a firm's MISA catalog, so each org keeps a small map from stock account to the
// two codes (crove_finance.misa_goods_code), editable in Settings, with the defaults below for accounts it has not set.
import { z } from 'zod';
import { zAccountCode } from './schemas.ts';

// The TT133 stock accounts whose purchases MISA records as goods received into a warehouse.
export const STOCK_ROOT_ACCOUNTS = ['152', '153', '156'] as const;
export type StockRootAccount = (typeof STOCK_ROOT_ACCOUNTS)[number];

// A sub-account's code starts with its parent's (accounts.ts), so the first three digits name the TT133 root.
export function stockRoot(code: string): StockRootAccount | null {
  const root = code.slice(0, 3);
  return (STOCK_ROOT_ACCOUNTS as readonly string[]).includes(root) ? (root as StockRootAccount) : null;
}

export function isStockAccount(code: string): boolean {
  return stockRoot(code) !== null;
}

// A MISA catalog code: letters, digits and _ . - /, at most 25 characters (MISA's limit for item codes; its import
// notes ask for codes without spaces). The database holds the same rule (misa_goods_code_*_format).
export const MISA_CODE_PATTERN = /^[A-Za-z0-9_./-]{1,25}$/;
export const zMisaCode = z.string().trim().regex(MISA_CODE_PATTERN);

export interface MisaGoodsCodes {
  itemCode: string;
  /** null: the "Kho" cell stays blank. */
  warehouseCode: string | null;
}

// Suggested codes for an account the org has not set: one generic item and one warehouse per kind of stock, named the
// usual way (nguyên vật liệu, công cụ dụng cụ, hàng hóa). The firm creates them in MISA once, or sets its own in
// Settings. Conventions, not MISA's: to confirm with the partner's catalog (#61).
export const MISA_GOODS_DEFAULTS: Readonly<Record<StockRootAccount, MisaGoodsCodes>> = {
  '152': { itemCode: 'NVL', warehouseCode: 'KNVL' },
  '153': { itemCode: 'CCDC', warehouseCode: 'KCCDC' },
  '156': { itemCode: 'HH', warehouseCode: 'KHH' },
};

export const zMisaGoodsCode = z.object({
  accountCode: zAccountCode,
  itemCode: z.string(),
  warehouseCode: z.string().nullable(),
  updatedAt: z.string(),
});
export type MisaGoodsCode = z.infer<typeof zMisaGoodsCode>;

export interface ResolvedMisaGoodsCodes extends MisaGoodsCodes {
  /** The account whose saved codes apply (the line's own or the nearest parent's), or null for the defaults. */
  from: string | null;
}

// Each account's parent in the org's chart (finance.accounts.list: parentCode, null for a level-1 TT133 account).
export type AccountParents = ReadonlyMap<string, string | null>;

export function accountParents(accounts: ReadonlyArray<{ code: string; parentCode: string | null }>): AccountParents {
  return new Map(accounts.map((a) => [a.code, a.parentCode]));
}

// The codes for a stock account: its own saved codes, else those of its nearest ancestor with saved codes, following
// the chart's parent chain (`parents`), else the default of its root. The chain, not the code text: 152.A is not the
// parent of 152.AB (both sit under 152), nor 1521 of 15212 when 15212 was created under 152 before 1521 existed. An
// account missing from `parents` inherits from nobody. null for an account that is not a stock account.
export function resolveMisaGoodsCodes(
  account: string,
  saved: ReadonlyArray<Pick<MisaGoodsCode, 'accountCode' | 'itemCode' | 'warehouseCode'>>,
  parents: AccountParents,
): ResolvedMisaGoodsCodes | null {
  const root = stockRoot(account);
  if (!root) return null;
  const byAccount = new Map(saved.map((row) => [row.accountCode, row]));
  const seen = new Set<string>();
  for (let code: string | null | undefined = account; code && !seen.has(code); code = parents.get(code)) {
    seen.add(code);
    const row = byAccount.get(code);
    if (row) return { itemCode: row.itemCode, warehouseCode: row.warehouseCode, from: row.accountCode };
  }
  return { ...MISA_GOODS_DEFAULTS[root], from: null };
}
