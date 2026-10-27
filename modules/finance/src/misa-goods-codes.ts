// The org's MISA SME item and warehouse codes for stock purchases (issue #1398), editable in Settings. The goods
// purchase export (GET /api/export/misa/goods-purchases.xlsx) fills "Mã hàng (*)" and "Kho" from them; an account
// without codes takes its nearest parent's, else the defaults (@crove/kernel-contract misa-goods.ts).
// - finance.misa_goods_codes.list: every member reads them, as every member may export.
// - finance.misa_goods_code.set / .remove: owners and admins set and clear one account's codes. R1: they change no
//   amount and no posted entry, only what the next export writes, and each is undone by the other.
// The database holds the same formats (20261102050000_crove_finance_misa_goods_codes.sql); the checks here come first
// so the refusal says what to do.
import { z } from 'zod';
import { isStockAccount, zAccountCode, zMisaCode, type MisaGoodsCode } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { chartAccounts } from './accounts.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

export const misaGoodsCodesList = defineQuery({
  name: 'finance.misa_goods_codes.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<MisaGoodsCode[]> => {
    const rows = await ctx.trx
      .selectFrom('crove_finance.misa_goods_code')
      .select(['account_code', 'item_code', 'warehouse_code', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('account_code')
      .execute();
    return rows.map((r) => ({
      accountCode: r.account_code,
      itemCode: r.item_code,
      warehouseCode: r.warehouse_code,
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  },
});

async function assertStockAccount(ctx: Parameters<typeof chartAccounts>[0], code: string): Promise<void> {
  if (!isStockAccount(code)) {
    throw new DomainError('NOT_STOCK_ACCOUNT', 422, `Tài khoản ${code} không phải tài khoản hàng tồn kho (152, 153, 156 hoặc tài khoản con của chúng)`);
  }
  if (!(await chartAccounts(ctx, [code])).has(code)) {
    throw new DomainError('UNKNOWN_ACCOUNT', 422, `Tài khoản ${code} không có trong hệ thống tài khoản của tổ chức`, { codes: [code] });
  }
}

export const setMisaGoodsCode = defineCommand({
  name: 'finance.misa_goods_code.set',
  input: z.object({ accountCode: zAccountCode, itemCode: zMisaCode, warehouseCode: zMisaCode.nullable() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, { accountCode, itemCode, warehouseCode }): Promise<MisaGoodsCode> => {
    await assertStockAccount(ctx, accountCode);
    const by = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const existing = await ctx.trx
      .selectFrom('crove_finance.misa_goods_code')
      .select(['id', 'item_code', 'warehouse_code'])
      .where('org_id', '=', ctx.orgId)
      .where('account_code', '=', accountCode)
      .forUpdate()
      .executeTakeFirst();
    let updatedAt: Date;
    if (existing) {
      const row = await ctx.trx
        .updateTable('crove_finance.misa_goods_code')
        .set({ item_code: itemCode, warehouse_code: warehouseCode, updated_by: by, updated_at: new Date() })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returning('updated_at')
        .executeTakeFirstOrThrow();
      updatedAt = new Date(row.updated_at);
    } else {
      const row = await ctx.trx
        .insertInto('crove_finance.misa_goods_code')
        .values({ org_id: ctx.orgId, account_code: accountCode, item_code: itemCode, warehouse_code: warehouseCode, updated_by: by })
        .returning('updated_at')
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          // Another request saved codes for the same account first.
          if (pgCode(error) === '23505') {
            throw new DomainError('MISA_CODE_CONFLICT', 409, `Mã MISA của tài khoản ${accountCode} vừa được người khác lưu; hãy tải lại trang rồi thử lại`);
          }
          throw error;
        });
      updatedAt = new Date(row.updated_at);
    }
    ctx.audit({
      accountCode,
      itemCode,
      warehouseCode,
      previous: existing ? { itemCode: existing.item_code, warehouseCode: existing.warehouse_code } : null,
    });
    return { accountCode, itemCode, warehouseCode, updatedAt: updatedAt.toISOString() };
  },
});

export const removeMisaGoodsCode = defineCommand({
  name: 'finance.misa_goods_code.remove',
  input: z.object({ accountCode: zAccountCode }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, { accountCode }) => {
    const removed = await ctx.trx
      .deleteFrom('crove_finance.misa_goods_code')
      .where('org_id', '=', ctx.orgId)
      .where('account_code', '=', accountCode)
      .returning(['item_code', 'warehouse_code'])
      .executeTakeFirst();
    ctx.audit({ accountCode, previous: removed ? { itemCode: removed.item_code, warehouseCode: removed.warehouse_code } : null });
    return { removed: removed !== undefined };
  },
});

export const misaGoodsCodeCommands = [setMisaGoodsCode, removeMisaGoodsCode];
export const misaGoodsCodeQueries = [misaGoodsCodesList];
