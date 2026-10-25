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

// The codes for a stock account: its own saved codes, else those of its nearest parent with saved codes (a
// sub-account's code starts with its parent's, so the longest saved code that prefixes it), else the default of its
// root. null for an account that is not a stock account.
export function resolveMisaGoodsCodes(account: string, saved: ReadonlyArray<Pick<MisaGoodsCode, 'accountCode' | 'itemCode' | 'warehouseCode'>>): ResolvedMisaGoodsCodes | null {
  const root = stockRoot(account);
  if (!root) return null;
  let best: (typeof saved)[number] | null = null;
  for (const row of saved) {
    if (!account.startsWith(row.accountCode)) continue;
    if (!best || row.accountCode.length > best.accountCode.length) best = row;
  }
  if (best) return { itemCode: best.itemCode, warehouseCode: best.warehouseCode, from: best.accountCode };
  return { ...MISA_GOODS_DEFAULTS[root], from: null };
}
