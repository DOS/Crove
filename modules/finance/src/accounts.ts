// The org's chart of accounts (issue #319): the TT133 accounts every org shares (crove_finance.account, read-only) and
// the org's own sub-accounts (crove_finance.org_account), plus the vendor default account.
// - finance.account.create / finance.account.update: owners and admins add, rename, deactivate and reactivate
//   sub-accounts. R1: they change no amount and no posted entry, and each is undone by the other (deactivate and
//   reactivate, rename back). A sub-account is never deleted and its code never changes, so every journal line that
//   names it keeps naming the same account.
// - finance.vendor.set_default_account: the debit account proposed first for a vendor's invoices (R1, owners and
//   admins), which approving an invoice also sets (finance.purchase.record).
// The database holds the same rules (20261019060000_crove_finance_sub_accounts.sql); the checks here come first so the
// refusal says what to do.
import { z } from 'zod';
import { isTaggedCode, subAccountCodeProblem, zAccountCode, zId } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type QueryContext } from '@crove/kernel-runtime';
import type { OpeningChartAccount } from './domain/opening-balance.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const zName = z.string().trim().min(1).max(200);
// How many vendor names a refusal lists.
const NAMED_VENDORS = 5;

export interface OrgChartAccount {
  code: string;
  name: string;
  parentCode: string | null;
  // The TT133 account the code rolls up to (its own code for a TT133 account).
  rootCode: string;
  active: boolean;
  // One of the org's sub-accounts, not a TT133 account.
  custom: boolean;
}

// The org's chart, or the accounts of it named in `codes`: TT133 accounts first match, then the org's sub-accounts.
export async function chartAccounts(ctx: QueryContext, codes?: readonly string[]): Promise<Map<string, OrgChartAccount>> {
  if (codes && codes.length === 0) return new Map();
  let tt133 = ctx.trx.selectFrom('crove_finance.account').select(['code', 'name', 'parent_code']);
  let own = ctx.trx
    .selectFrom('crove_finance.org_account')
    .select(['code', 'name', 'parent_code', 'root_code', 'active'])
    .where('org_id', '=', ctx.orgId);
  if (codes) {
    tt133 = tt133.where('code', 'in', [...codes]);
    own = own.where('code', 'in', [...codes]);
  }
  const chart = new Map<string, OrgChartAccount>();
  for (const a of await tt133.execute()) {
    chart.set(a.code, { code: a.code, name: a.name, parentCode: a.parent_code, rootCode: a.code, active: true, custom: false });
  }
  for (const a of await own.execute()) {
    if (chart.has(a.code)) continue;
    chart.set(a.code, { code: a.code, name: a.name, parentCode: a.parent_code, rootCode: a.root_code, active: a.active, custom: true });
  }
  return chart;
}

// The org's chart as the opening balance check reads it (#320): every account it may name, with whether it is in use.
// A firm imports its opening balances onto TT133 accounts and its own active sub-accounts; an inactive one is flagged.
export async function chartOfAccounts(ctx: QueryContext): Promise<Map<string, OpeningChartAccount>> {
  return new Map([...(await chartAccounts(ctx)).values()].map((a) => [a.code, { code: a.code, name: a.name, active: a.active }]));
}

// Refuses a code that is not in the org's chart, or a sub-account that is no longer in use, for a new posting or a
// vendor default. (A reversal posts on the accounts of the entry it reverses, whatever their state.)
export async function assertUsableAccounts(ctx: QueryContext, codes: readonly string[]): Promise<void> {
  const unique = [...new Set(codes)];
  const chart = await chartAccounts(ctx, unique);
  const unknown = unique.filter((c) => !chart.has(c));
  if (unknown.length > 0) {
    throw new DomainError('UNKNOWN_ACCOUNT', 422, `Tài khoản ${unknown.join(', ')} không có trong hệ thống tài khoản của tổ chức`, { codes: unknown });
  }
  const inactive = unique.filter((c) => chart.get(c)?.active === false);
  if (inactive.length > 0) {
    throw new DomainError('ACCOUNT_INACTIVE', 422, `Tài khoản ${inactive.join(', ')} đã ngừng sử dụng; hãy chọn tài khoản khác`, { codes: inactive });
  }
}

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

export const createAccount = defineCommand({
  name: 'finance.account.create',
  input: z.object({ parentCode: zAccountCode, code: zAccountCode, name: zName }),
  risk: 'R1',
  access: MANAGERS,
  handler: async (ctx, { parentCode, code, name }) => {
    const problem = subAccountCodeProblem(parentCode, code);
    if (problem === 'parent_tagged') {
      throw new DomainError('PARENT_TAGGED', 422, `Tài khoản ${parentCode} có ký hiệu nên không có tài khoản con`);
    }
    if (problem) {
      throw new DomainError(
        'INVALID_SUB_ACCOUNT_CODE',
        422,
        `Mã tài khoản con phải bắt đầu bằng ${parentCode} rồi thêm chữ số (ví dụ ${parentCode}1) hoặc dấu chấm và ký hiệu (ví dụ ${parentCode}.VCB)`,
      );
    }
    const chart = await chartAccounts(ctx, [parentCode, code]);
    const existing = chart.get(code);
    if (existing) {
      throw new DomainError(
        'ACCOUNT_CODE_TAKEN',
        409,
        existing.custom ? `Mã ${code} đã có trong hệ thống tài khoản của tổ chức` : `Mã ${code} là tài khoản theo TT133; hãy chọn mã khác`,
      );
    }
    const parent = chart.get(parentCode);
    if (!parent) throw new DomainError('PARENT_NOT_FOUND', 422, `Không có tài khoản ${parentCode} trong hệ thống tài khoản của tổ chức`);
    // A sub-account parent is locked until commit, so it cannot be deactivated before the new child is in (the
    // database's insert trigger takes the same lock).
    const parentActive = parent.custom
      ? (
          await ctx.trx
            .selectFrom('crove_finance.org_account')
            .select('active')
            .where('org_id', '=', ctx.orgId)
            .where('code', '=', parentCode)
            .forShare()
            .executeTakeFirst()
        )?.active === true
      : true;
    if (!parentActive) throw new DomainError('PARENT_INACTIVE', 422, `Tài khoản ${parentCode} đã ngừng sử dụng`);
    // A digit code goes under the most detailed account it extends (13321 under 1332, not 133), so the roll-up by code
    // prefix (B01, B02) and by parent (trial balance, general ledger) agree.
    const between = isTaggedCode(code)
      ? []
      : Array.from({ length: code.length - parentCode.length - 1 }, (_, i) => code.slice(0, parentCode.length + i + 1));
    const deeper = [...(await chartAccounts(ctx, between)).keys()].sort((a, b) => b.length - a.length)[0];
    if (deeper) {
      throw new DomainError('PARENT_NOT_DEEPEST', 422, `Mã ${code} nằm dưới tài khoản ${deeper}; hãy chọn ${deeper} làm tài khoản cha`, { parentCode: deeper });
    }
    const created = await ctx.trx
      .insertInto('crove_finance.org_account')
      .values({ org_id: ctx.orgId, code, name, parent_code: parentCode, created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        // Another request added the same code first.
        if (pgCode(error) === '23505') throw new DomainError('ACCOUNT_CODE_TAKEN', 409, `Mã ${code} đã có trong hệ thống tài khoản của tổ chức`);
        throw error;
      });
    ctx.audit({ code, parentCode, rootCode: parent.rootCode });
    await ctx.activity('finance.org_account', created.id, 'account.created', `Thêm tài khoản ${code} ${name}`);
    return { id: created.id, code };
  },
});

export const updateAccount = defineCommand({
  name: 'finance.account.update',
  input: z
    .object({ code: zAccountCode, name: zName.optional(), active: z.boolean().optional() })
    .refine((i) => i.name !== undefined || i.active !== undefined, 'name or active'),
  risk: 'R1',
  access: MANAGERS,
  handler: async (ctx, input) => {
    const { code } = input;
    const tt133 = await ctx.trx.selectFrom('crove_finance.account').select('code').where('code', '=', code).executeTakeFirst();
    if (tt133) {
      throw new DomainError('ACCOUNT_READ_ONLY', 422, `Tài khoản ${code} theo TT133 không sửa hay ngừng dùng được; hãy tạo tài khoản con của nó`);
    }
    // Locked first: a vendor default being set on it (which takes a share lock) finishes before the checks below.
    const account = await ctx.trx
      .selectFrom('crove_finance.org_account')
      .select(['id', 'name', 'active', 'parent_code'])
      .where('org_id', '=', ctx.orgId)
      .where('code', '=', code)
      .forUpdate()
      .executeTakeFirst();
    if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', 404, `Không có tài khoản ${code} trong hệ thống tài khoản của tổ chức`);
    const name = input.name ?? account.name;
    const active = input.active ?? account.active;
    if (account.active && !active) {
      const vendors = await ctx.trx
        .selectFrom('crove_finance.vendor_account_rule as r')
        .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'r.org_id').onRef('p.id', '=', 'r.party_id'))
        .select(['p.id', 'p.name'])
        .where('r.org_id', '=', ctx.orgId)
        .where('r.debit_account', '=', code)
        .orderBy('p.name')
        .execute();
      if (vendors.length > 0) {
        const named = vendors.slice(0, NAMED_VENDORS).map((v) => v.name);
        const more = vendors.length > NAMED_VENDORS ? ` và ${vendors.length - NAMED_VENDORS} nhà cung cấp khác` : '';
        throw new DomainError(
          'ACCOUNT_IS_VENDOR_DEFAULT',
          409,
          `Tài khoản ${code} đang là tài khoản mặc định của ${named.join(', ')}${more}. Hãy đổi tài khoản mặc định của các nhà cung cấp này (trang Nhà cung cấp) rồi ngừng dùng tài khoản`,
          { vendors: vendors.slice(0, NAMED_VENDORS), count: vendors.length },
        );
      }
      const children = await ctx.trx
        .selectFrom('crove_finance.org_account')
        .select('code')
        .where('org_id', '=', ctx.orgId)
        .where('parent_code', '=', code)
        .where('active', '=', true)
        .orderBy('code')
        .execute();
      if (children.length > 0) {
        throw new DomainError(
          'ACCOUNT_HAS_SUB_ACCOUNTS',
          409,
          `Tài khoản ${code} còn tài khoản con đang dùng (${children.map((c) => c.code).join(', ')}); hãy ngừng dùng chúng trước`,
        );
      }
    }
    if (!account.active && active) {
      const parent = await ctx.trx
        .selectFrom('crove_finance.org_account')
        .select('active')
        .where('org_id', '=', ctx.orgId)
        .where('code', '=', account.parent_code)
        .executeTakeFirst();
      if (parent && !parent.active) {
        throw new DomainError('PARENT_INACTIVE', 409, `Tài khoản cha ${account.parent_code} đã ngừng sử dụng; hãy dùng lại nó trước`);
      }
    }
    if (name === account.name && active === account.active) return { code, name, active };
    await ctx.trx
      .updateTable('crove_finance.org_account')
      .set({ name, active, updated_by: ctx.actor.type === 'user' ? ctx.actor.userId : null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', account.id)
      .execute()
      .catch((error: unknown) => {
        // The database refused the change (a vendor default or a sub-account appeared meanwhile).
        if (pgCode(error) === '23503') throw new DomainError('ACCOUNT_IN_USE', 409, `Tài khoản ${code} đang được dùng; hãy tải lại trang rồi thử lại`);
        throw error;
      });
    ctx.audit({ code, previous: { name: account.name, active: account.active }, name, active });
    const summary =
      active !== account.active
        ? `${active ? 'Dùng lại' : 'Ngừng dùng'} tài khoản ${code} ${name}`
        : `Đổi tên tài khoản ${code} thành ${name}`;
    await ctx.activity('finance.org_account', account.id, active !== account.active ? (active ? 'account.reactivated' : 'account.deactivated') : 'account.renamed', summary);
    return { code, name, active };
  },
});

export const setVendorDefaultAccount = defineCommand({
  name: 'finance.vendor.set_default_account',
  input: z.object({ partyId: zId, accountCode: zAccountCode.nullable() }),
  risk: 'R1',
  access: MANAGERS,
  handler: async (ctx, { partyId, accountCode }) => {
    const party = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', partyId)
      .executeTakeFirst();
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy nhà cung cấp');
    const previous = await ctx.trx
      .selectFrom('crove_finance.vendor_account_rule')
      .select('debit_account')
      .where('org_id', '=', ctx.orgId)
      .where('party_id', '=', partyId)
      .executeTakeFirst();
    const before = previous?.debit_account ?? null;
    if (before === accountCode) return { partyId, accountCode };
    const by = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    if (accountCode === null) {
      await ctx.trx.deleteFrom('crove_finance.vendor_account_rule').where('org_id', '=', ctx.orgId).where('party_id', '=', partyId).execute();
    } else {
      await assertUsableAccounts(ctx, [accountCode]);
      await ctx.trx
        .insertInto('crove_finance.vendor_account_rule')
        .values({ org_id: ctx.orgId, party_id: partyId, debit_account: accountCode, confirmed_by: by })
        .onConflict((oc) => oc.columns(['org_id', 'party_id']).doUpdateSet({ debit_account: accountCode, confirmed_by: by, updated_at: ctx.now }))
        .execute()
        .catch((error: unknown) => {
          // The sub-account was deactivated meanwhile (the database checks it under a lock).
          if (pgCode(error) === '23503') throw new DomainError('ACCOUNT_INACTIVE', 422, `Tài khoản ${accountCode} đã ngừng sử dụng; hãy chọn tài khoản khác`);
          throw error;
        });
    }
    ctx.audit({ partyId, accountCode, previous: before });
    await ctx.activity(
      'kernel.party',
      partyId,
      'vendor.default_account',
      accountCode ? `Tài khoản mặc định của ${party.name}: ${accountCode}` : `Bỏ tài khoản mặc định của ${party.name}`,
    );
    return { partyId, accountCode };
  },
});
