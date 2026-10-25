// The register of fixed assets and prepaid costs (#919): what a user enters and what the register shows. The finance
// module decides every rule (modules/finance/src/fixed-assets.ts); the shapes here are shared with the SPA.
import { z } from 'zod';
import { zAccountCode, zId, zJournalAmount, zMoney } from './schemas.ts';
import { zMonth } from './journal-voucher.ts';

export const FIXED_ASSET_KINDS = ['fixed_asset', 'prepaid_cost'] as const;
export const zFixedAssetKind = z.enum(FIXED_ASSET_KINDS);

export const zFixedAssetCreate = z.object({
  kind: zFixedAssetKind,
  name: z.string().trim().min(1).max(500),
  // Whole dong, like the monthly amounts it is split into.
  cost: zJournalAmount,
  // 211x or 213x for a fixed asset, 242 for a prepaid cost or tool.
  assetAccount: zAccountCode,
  // 214x for a fixed asset; absent for a prepaid cost.
  accumulatedAccount: zAccountCode.nullable().optional(),
  // Where the monthly amount goes: 154, 6xx or 8xx.
  expenseAccount: zAccountCode,
  startMonth: zMonth,
  months: z.number().int().min(1).max(600),
  // The approved purchase line it comes from, when it does.
  source: z.object({ documentId: zId, lineNo: z.number().int().positive() }).nullable().optional(),
  // The register of one legal entity (#1280), as in zLegalEntityChoice; an entry from a purchase line is in the
  // document's entity.
  legalEntityId: zId.optional(),
});
export type FixedAssetCreate = z.infer<typeof zFixedAssetCreate>;

export const zFixedAssetEnd = z.object({
  assetId: zId,
  // The last month that still counts.
  month: zMonth,
  reason: z.string().trim().min(1).max(500),
});

export const zFixedAsset = z.object({
  id: zId,
  kind: zFixedAssetKind,
  name: z.string(),
  cost: zMoney,
  assetAccount: z.string(),
  accumulatedAccount: z.string().nullable(),
  expenseAccount: z.string(),
  startMonth: zMonth,
  months: z.number().int(),
  // The planned last month of the schedule.
  lastMonth: zMonth,
  ended: z.object({ month: zMonth, reason: z.string() }).nullable(),
  source: z.object({ documentId: zId, lineNo: z.number().int() }).nullable(),
  // What was posted so far, the months posted, and what is left in the books.
  posted: zMoney,
  postedMonths: z.number().int(),
  remaining: zMoney,
  // The latest month posted, or null.
  lastPostedMonth: zMonth.nullable(),
});
export type FixedAsset = z.infer<typeof zFixedAsset>;
