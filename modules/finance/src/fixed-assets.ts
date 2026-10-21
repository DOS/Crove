// The register of fixed assets and prepaid costs, and their monthly depreciation and allocation (issue #919).
// - finance.fixed_asset.create (R1, audited): an entry, by hand or from an approved purchase line.
// - finance.fixed_asset.end (R1, audited): stops a schedule early (disposed of, written off); the month named still counts.
// - finance.fixed_assets.list: the register with what was posted and what is left.
// - finance.depreciation.prepare: a user names a month through kernel.proposal.request; this reads the register and
//   builds one general journal voucher dated the month's last day, Dr expense / Cr 214x (fixed assets) or 242
//   (prepaid costs), grouped by account, with each asset's amount. It writes nothing; it refuses a locked month and a
//   month already posted.
// - finance.depreciation.record: runs only through kernel.proposal.approve (R3, P10 four-eyes, P11 fresh MFA, P12). It
//   builds the month again from the register and refuses a proposal that no longer matches, then posts the voucher
//   like any NVK (journal-voucher.ts) and writes one depreciation line per asset.
// A month posted by mistake is undone by reversing its entry; its depreciation lines stay, so the month is not posted
// twice by accident: posting it again is a general journal voucher by hand.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DEPRECIATION_COMMAND,
  JOURNAL_VOUCHER_KIND,
  zDepreciationProposal,
  zDepreciationRequest,
  zFixedAssetCreate,
  zFixedAssetEnd,
  type DepreciationProposal,
  type FixedAsset,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';
import { lastMonth, monthAmount, monthsBetween, remainingValue } from './domain/depreciation.ts';
import { journalVoucherTitle, journalVoucherTotal } from './domain/journal-voucher.ts';
import { canonical } from './domain/money.ts';
import { postJournalVoucher } from './journal-voucher.ts';
import { dateLabel, periodLockState } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const monthOf = (date: string) => date.slice(0, 7);
const firstDay = (month: string) => `${month}-01`;
function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

interface AssetRow {
  id: string;
  kind: 'fixed_asset' | 'prepaid_cost';
  name: string;
  cost: string;
  asset_account: string;
  accumulated_account: string | null;
  expense_account: string;
  start_month: string;
  months: number;
  ended_month: string | null;
  end_reason: string | null;
  source_document_id: string | null;
  source_line_no: number | null;
}

function assetRows(ctx: QueryContext) {
  return ctx.trx
    .selectFrom('crove_finance.fixed_asset')
    .select([
      'id',
      'kind',
      'name',
      'cost',
      'asset_account',
      'accumulated_account',
      'expense_account',
      sql<string>`pg_catalog.to_char(start_month, 'YYYY-MM-DD')`.as('start_month'),
      'months',
      sql<string | null>`pg_catalog.to_char(ended_month, 'YYYY-MM-DD')`.as('ended_month'),
      'end_reason',
      'source_document_id',
      'source_line_no',
    ])
    .where('org_id', '=', ctx.orgId);
}

const scheduled = (a: AssetRow) => ({ cost: a.cost, startMonth: a.start_month, months: a.months, endedMonth: a.ended_month });

export const createFixedAsset = defineCommand({
  name: 'finance.fixed_asset.create',
  input: zFixedAssetCreate,
  risk: 'R1',
  access: REQUESTERS,
  handler: async (ctx, input) => {
    const fixed = input.kind === 'fixed_asset';
    const accumulated = input.accumulatedAccount ?? null;
    const prefix = (code: string, ...p: string[]) => p.some((x) => code.startsWith(x));
    if (fixed ? !prefix(input.assetAccount, '211', '213') || accumulated === null || !prefix(accumulated, '214') : !prefix(input.assetAccount, '242') || accumulated !== null) {
      throw new DomainError(
        'ASSET_ACCOUNTS',
        422,
        fixed ? 'Tài sản cố định ghi trên tài khoản 211 hoặc 213, khấu hao lũy kế trên tài khoản 214' : 'Chi phí trả trước ghi trên tài khoản 242 và không có tài khoản hao mòn',
      );
    }
    if (!prefix(input.expenseAccount, '6', '8', '154')) {
      throw new DomainError('ASSET_ACCOUNTS', 422, 'Tài khoản chi phí phải là 154, tài khoản loại 6 hoặc loại 8');
    }
    await assertUsableAccounts(ctx, [input.assetAccount, input.expenseAccount, ...(accumulated ? [accumulated] : [])]);
    const source = input.source ?? null;
    if (source) {
      // A live purchase of the org whose line was posted to this asset account, for this cost.
      const line = await ctx.trx
        .selectFrom('crove_finance.purchase_line as l')
        .innerJoin('crove_finance.purchase_document as d', (join) => join.onRef('d.org_id', '=', 'l.org_id').onRef('d.id', '=', 'l.document_id'))
        .select(['l.amount', 'l.debit_account', 'd.direction'])
        .where('l.org_id', '=', ctx.orgId)
        .where('l.document_id', '=', source.documentId)
        .where('l.line_no', '=', source.lineNo)
        .where(({ not, exists, selectFrom }) =>
          not(exists(selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'))),
        )
        .executeTakeFirst();
      if (!line || line.direction !== 'purchase') throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy dòng hóa đơn mua vào này');
      if (line.debit_account !== input.assetAccount || !money(line.amount).equals(money(input.cost))) {
        throw new DomainError('SOURCE_MISMATCH', 422, `Dòng hóa đơn ghi ${money(line.amount).toFixed()} đ vào tài khoản ${line.debit_account}; tài sản phải cùng tài khoản và nguyên giá`);
      }
    }
    const row = await ctx.trx
      .insertInto('crove_finance.fixed_asset')
      .values({
        org_id: ctx.orgId,
        kind: input.kind,
        name: input.name,
        cost: input.cost,
        asset_account: input.assetAccount,
        accumulated_account: accumulated,
        expense_account: input.expenseAccount,
        start_month: firstDay(input.startMonth),
        months: input.months,
        source_document_id: source?.documentId ?? null,
        source_line_no: source?.lineNo ?? null,
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((error: { code?: string }) => {
        if (error?.code === '23505') throw new DomainError('ASSET_EXISTS', 409, 'Dòng hóa đơn này đã có trong sổ tài sản');
        throw error;
      });
    ctx.audit({ asset_id: row.id, kind: input.kind, cost: input.cost, months: input.months });
    await ctx.activity('finance.fixed_asset', row.id, 'fixed_asset.created', `Ghi sổ tài sản: ${input.name}`);
    return { assetId: row.id };
  },
});

export const endFixedAsset = defineCommand({
  name: 'finance.fixed_asset.end',
  input: zFixedAssetEnd,
  risk: 'R1',
  access: REQUESTERS,
  target: (input) => ({ type: 'finance.fixed_asset', id: input.assetId }),
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới dừng được tài sản');
    const asset = await assetRows(ctx).where('id', '=', input.assetId).forUpdate().executeTakeFirst();
    if (!asset) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tài sản');
    if (asset.ended_month) throw new DomainError('ASSET_ENDED', 409, 'Tài sản này đã dừng');
    const ended = firstDay(input.month);
    if (monthsBetween(asset.start_month, ended) < -1) {
      throw new DomainError('ASSET_END_BEFORE_START', 422, `Tháng dừng phải từ tháng trước tháng bắt đầu ${monthLabel(monthOf(asset.start_month))}`);
    }
    // A month already posted still counts: the schedule cannot end before it.
    const posted = await ctx.trx
      .selectFrom('crove_finance.depreciation_line')
      .select(sql<string | null>`pg_catalog.to_char(pg_catalog.max(month), 'YYYY-MM-DD')`.as('last'))
      .where('org_id', '=', ctx.orgId)
      .where('asset_id', '=', asset.id)
      .executeTakeFirst();
    if (posted?.last && posted.last > ended) {
      throw new DomainError('ASSET_END_BEFORE_POSTED', 409, `Tài sản đã khấu hao đến tháng ${monthLabel(monthOf(posted.last))}; hãy chọn tháng dừng từ tháng đó`);
    }
    await ctx.trx
      .updateTable('crove_finance.fixed_asset')
      .set({ ended_month: ended, end_reason: input.reason, ended_by: ctx.actor.userId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', asset.id)
      .execute();
    ctx.audit({ asset_id: asset.id, ended_month: input.month });
    await ctx.activity('finance.fixed_asset', asset.id, 'fixed_asset.ended', `Dừng tài sản: ${asset.name}`);
    return { assetId: asset.id };
  },
});

export const fixedAssetsQuery = defineQuery({
  name: 'finance.fixed_assets.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<FixedAsset[]> => {
    const assets = await assetRows(ctx).orderBy('start_month').orderBy('created_at').orderBy('id').limit(5000).execute();
    if (assets.length === 0) return [];
    const posted = await ctx.trx
      .selectFrom('crove_finance.depreciation_line')
      .select(['asset_id'])
      .select((eb) => [eb.fn.sum<string>('amount').as('posted'), eb.fn.countAll<string>().as('months'), sql<string>`pg_catalog.to_char(pg_catalog.max(month), 'YYYY-MM-DD')`.as('last')])
      .where('org_id', '=', ctx.orgId)
      .groupBy('asset_id')
      .execute();
    const byAsset = new Map(posted.map((p) => [p.asset_id, p]));
    return assets.map((a) => {
      const p = byAsset.get(a.id);
      const total = p ? canonical(money(p.posted)) : '0';
      return {
        id: a.id,
        kind: a.kind,
        name: a.name,
        cost: canonical(money(a.cost)),
        assetAccount: a.asset_account,
        accumulatedAccount: a.accumulated_account,
        expenseAccount: a.expense_account,
        startMonth: monthOf(a.start_month),
        months: a.months,
        lastMonth: monthOf(lastMonth(scheduled(a))),
        ended: a.ended_month && a.end_reason ? { month: monthOf(a.ended_month), reason: a.end_reason } : null,
        source: a.source_document_id && a.source_line_no !== null ? { documentId: a.source_document_id, lineNo: a.source_line_no } : null,
        posted: total,
        postedMonths: p ? Number(p.months) : 0,
        remaining: remainingValue(a.cost, [total]),
        lastPostedMonth: p?.last ? monthOf(p.last) : null,
      };
    });
  },
});

// The month's voucher from the register as it reads now. Refuses a locked month, a month with nothing to post, and
// a month already posted.
async function buildDepreciation(ctx: QueryContext, month: string): Promise<DepreciationProposal> {
  const date = lastDay(month);
  const { lockedThrough } = await periodLockState(ctx);
  if (lockedThrough && date <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(date)}`, {
      lockedThrough,
      entryDate: date,
    });
  }
  const assets = await assetRows(ctx).where('start_month', '<=', firstDay(month)).orderBy('id').execute();
  const due = assets.map((a) => ({ asset: a, amount: monthAmount(scheduled(a), firstDay(month)) })).filter((d) => !money(d.amount).isZero());
  if (due.length === 0) throw new DomainError('DEPRECIATION_EMPTY', 422, `Tháng ${monthLabel(month)} không có tài sản nào cần khấu hao hay phân bổ`);
  const done = await ctx.trx
    .selectFrom('crove_finance.depreciation_line')
    .select('asset_id')
    .where('org_id', '=', ctx.orgId)
    .where('month', '=', firstDay(month))
    .execute();
  const posted = new Set(done.map((d) => d.asset_id));
  const open = due.filter((d) => !posted.has(d.asset.id));
  if (open.length === 0) throw new DomainError('DEPRECIATION_DONE', 409, `Tháng ${monthLabel(month)} đã khấu hao và phân bổ rồi`);
  // Amounts are whole dong (zJournalAmount): a cost with a fraction of a dong is refused below.
  const debit = new Map<string, ReturnType<typeof money>>();
  const credit = new Map<string, ReturnType<typeof money>>();
  for (const { asset, amount } of open) {
    debit.set(asset.expense_account, (debit.get(asset.expense_account) ?? money(0)).plus(money(amount)));
    const against = asset.accumulated_account ?? asset.asset_account;
    credit.set(against, (credit.get(against) ?? money(0)).plus(money(amount)));
  }
  const sorted = (m: Map<string, ReturnType<typeof money>>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    ...sorted(debit).map(([account, v]) => ({ account, party: null, debit: canonical(v), credit: '0' })),
    ...sorted(credit).map(([account, v]) => ({ account, party: null, debit: '0', credit: canonical(v) })),
  ];
  const built = {
    date,
    description: `Khấu hao TSCĐ và phân bổ chi phí trả trước tháng ${monthLabel(month)}`,
    lines,
    total: journalVoucherTotal(lines),
    depreciationMonth: month,
    assets: open.map((d) => ({ assetId: d.asset.id, amount: d.amount })),
  };
  const parsed = zDepreciationProposal.safeParse(built);
  if (!parsed.success) {
    throw new DomainError('DEPRECIATION_UNSUPPORTED', 422, `Không lập được bút toán khấu hao tháng ${monthLabel(month)}: quá nhiều tài khoản hoặc có số tiền lẻ dưới 1 đồng`, {
      fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
    });
  }
  return parsed.data;
}

export const prepareDepreciation = defineCommand({
  name: 'finance.depreciation.prepare',
  input: zDepreciationRequest,
  risk: 'R1',
  access: REQUESTERS,
  handler: async (ctx, { month }) => {
    const payload = await buildDepreciation(ctx, month);
    return { kind: JOURNAL_VOUCHER_KIND, command: DEPRECIATION_COMMAND, title: journalVoucherTitle(payload), payload };
  },
});

const sameProposal = (a: DepreciationProposal, b: DepreciationProposal) =>
  a.date === b.date &&
  a.description === b.description &&
  a.total === b.total &&
  JSON.stringify(a.lines) === JSON.stringify(b.lines.map((l) => ({ account: l.account, party: l.party, debit: l.debit, credit: l.credit }))) &&
  JSON.stringify(a.assets) === JSON.stringify(b.assets);

export const recordDepreciation = defineCommand({
  name: DEPRECIATION_COMMAND,
  input: z.object({ payload: zDepreciationProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const month = payload.depreciationMonth;
    // One depreciation of the org at a time: a second approval waits here, then finds the month posted.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_finance.depreciation:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    // The month is built again from the register; an entry added, changed or ended since makes the proposal stale.
    const current = await buildDepreciation(ctx, month);
    if (!sameProposal(current, payload)) {
      throw new DomainError('DEPRECIATION_STALE', 409, `Sổ tài sản đã thay đổi từ khi lập đề xuất khấu hao tháng ${monthLabel(month)}; hãy từ chối đề xuất này và lập lại`);
    }
    const result = await postJournalVoucher(ctx, payload);
    await ctx.trx
      .insertInto('crove_finance.depreciation_line')
      .values(payload.assets.map((a) => ({ org_id: ctx.orgId, asset_id: a.assetId, month: firstDay(month), amount: a.amount, entry_id: result.journalEntryId })))
      .execute();
    return result;
  },
});

// Records one Excel export of the register after the workbook is built. It changes nothing: its audit row (the number
// of entries) is the record of who took the register out, and a failure stops the download.
export const exportFixedAssets = defineCommand({
  name: 'finance.fixed_asset.export',
  input: z.object({ assets: z.number().int().min(0) }),
  risk: 'R0',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({ assets: input.assets });
    return { ok: true as const };
  },
});

export const fixedAssetCommands = [createFixedAsset, endFixedAsset, prepareDepreciation, recordDepreciation, exportFixedAssets];
export const fixedAssetQueries = [fixedAssetsQuery];
