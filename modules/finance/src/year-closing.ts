// Year-end closing (issue #889), kết chuyển: the revenue, income, cost and expense accounts (classes 5 to 8) are moved
// to 911 and the year's result to 4212, as one general journal voucher dated the year's last day. It is a posting, so
// it follows the rules of every posting (plan §4.7: R3, P10 four-eyes, P11 fresh MFA, P12 eligible approvers):
// - finance.closing.prepare: a user names the year through kernel.proposal.request; this reads the ledger and builds
//   the lines (domain/year-closing.ts). It writes nothing. The year must have ended and not be locked or closed.
// - finance.closing.record: runs only through kernel.proposal.approve. It builds the lines again from the ledger and
//   refuses a proposal they no longer match (a posting dated in the year since), then posts the voucher like any NVK
//   (journal-voucher.ts), with closing_year set.
// A closing is undone by reversing its entry (finance.journal.reverse) on the year's last day; the year can then be
// closed again.
import { z } from 'zod';
import {
  JOURNAL_VOUCHER_KIND,
  YEAR_CLOSING_COMMAND,
  zYearClosingProposal,
  zYearClosingRequest,
  type YearClosingProposal,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type QueryContext } from '@crove/kernel-runtime';
import { sql } from 'kysely';
import { JOURNAL_VOUCHER_SOURCE, journalVoucherTitle, journalVoucherTotal } from './domain/journal-voucher.ts';
import { closingDescription, closingLines, type AccountBalance, type ClosingLine } from './domain/year-closing.ts';
import { postJournalVoucher } from './journal-voucher.ts';
import { databaseToday, dateLabel, periodLockState } from './period-lock.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const yearEnd = (year: number) => `${year}-12-31`;

// Each class 5 to 9 account's debits and credits through the year's last day, every entry and reversal included, so
// what an earlier closing moved is already netted out.
async function resultBalances(ctx: QueryContext, year: number): Promise<AccountBalance[]> {
  const rows = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .select('l.account_code')
    .select((eb) => [eb.fn.sum<string>('l.debit').as('debit'), eb.fn.sum<string>('l.credit').as('credit')])
    .where('l.org_id', '=', ctx.orgId)
    .where('j.entry_date', '<=', yearEnd(year))
    .where((eb) => eb.or(['5', '6', '7', '8', '9'].map((c) => eb('l.account_code', 'like', `${c}%`))))
    .groupBy('l.account_code')
    .execute();
  return rows.map((r) => ({ accountCode: r.account_code, debit: r.debit ?? '0', credit: r.credit ?? '0' }));
}

// Whether the year has a closing in force: a closing voucher whose entry has no reversal dated in the year. A reversal
// dated later leaves the year's balances closed, so the year stays closed.
async function isClosed(ctx: QueryContext, year: number): Promise<boolean> {
  const row = await ctx.trx
    .selectFrom('crove_finance.journal_voucher as v')
    .innerJoin('crove_finance.journal_entry as e', (join) =>
      join.onRef('e.org_id', '=', 'v.org_id').onRef('e.source_id', '=', 'v.id').on('e.source_type', '=', JOURNAL_VOUCHER_SOURCE).on('e.reverses_entry_id', 'is', null),
    )
    .select('v.id')
    .where('v.org_id', '=', ctx.orgId)
    .where('v.closing_year', '=', year)
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom('crove_finance.journal_entry as r').select(sql<number>`1`.as('one')).whereRef('r.org_id', '=', 'e.org_id').whereRef('r.reverses_entry_id', '=', 'e.id').where('r.entry_date', '<=', yearEnd(year)))),
    )
    .executeTakeFirst();
  return row !== undefined;
}

// The closing of the year as a proposal payload, from the ledger as it reads now. Refuses a year with nothing to
// close, and lines a voucher cannot hold (more than its line limit, or a fraction of a dong). Unlike a voucher entered
// by hand, an inactive sub-account is not refused: its balance must be closed too.
async function buildClosing(ctx: QueryContext, year: number): Promise<YearClosingProposal> {
  const lines = closingLines(await resultBalances(ctx, year));
  if (lines.length === 0) throw new DomainError('CLOSING_EMPTY', 422, `Năm ${year} không có số dư doanh thu, chi phí để kết chuyển`);
  const built = {
    date: yearEnd(year),
    description: closingDescription(year),
    lines: lines.map((l) => ({ account: l.account, party: null, debit: l.debit, credit: l.credit })),
    total: journalVoucherTotal(lines),
    closingYear: year,
  };
  const parsed = zYearClosingProposal.safeParse(built);
  if (!parsed.success) {
    throw new DomainError('CLOSING_UNSUPPORTED', 422, `Không lập được bút toán kết chuyển năm ${year}: quá nhiều tài khoản hoặc có số tiền lẻ dưới 1 đồng; hãy kết chuyển bằng phiếu kế toán`, {
      fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
    });
  }
  return parsed.data;
}

// The year has ended by the database clock, is not locked and has no closing in force.
async function assertClosable(ctx: QueryContext, year: number) {
  const today = await databaseToday(ctx.trx);
  if (yearEnd(year) >= today) throw new DomainError('YEAR_NOT_ENDED', 422, `Năm ${year} chưa kết thúc nên chưa kết chuyển được`);
  const { lockedThrough } = await periodLockState(ctx);
  if (lockedThrough && yearEnd(year) <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(yearEnd(year))}`, {
      lockedThrough,
      entryDate: yearEnd(year),
    });
  }
  if (await isClosed(ctx, year)) throw new DomainError('YEAR_CLOSED', 409, `Năm ${year} đã kết chuyển; muốn làm lại thì đảo bút toán kết chuyển với ngày ${dateLabel(yearEnd(year))} trước`);
}

const sameLines = (a: readonly ClosingLine[], b: YearClosingProposal['lines']) =>
  a.length === b.length && a.every((l, i) => l.account === b[i]?.account && l.debit === b[i]?.debit && l.credit === b[i]?.credit && b[i]?.party === null);

export const prepareYearClosing = defineCommand({
  name: 'finance.closing.prepare',
  input: zYearClosingRequest,
  risk: 'R1',
  access: REQUESTERS,
  handler: async (ctx, { year }) => {
    await assertClosable(ctx, year);
    const payload = await buildClosing(ctx, year);
    return { kind: JOURNAL_VOUCHER_KIND, command: YEAR_CLOSING_COMMAND, title: journalVoucherTitle(payload), payload };
  },
});

export const recordYearClosing = defineCommand({
  name: YEAR_CLOSING_COMMAND,
  input: z.object({ payload: zYearClosingProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const year = payload.closingYear;
    // One closing of the org at a time: a second approval waits here, then finds the year closed.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove_finance.year_closing:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    await assertClosable(ctx, year);
    if (payload.date !== yearEnd(year) || payload.description !== closingDescription(year)) {
      throw new DomainError('CLOSING_STALE', 409, `Đề xuất kết chuyển năm ${year} không còn khớp sổ; hãy lập lại`);
    }
    // The lines are built again from the ledger as it reads now; a posting dated in the year since the proposal was
    // made changes them, and the proposal is refused rather than posting a closing that leaves balances behind.
    const current = closingLines(await resultBalances(ctx, year));
    if (!sameLines(current, payload.lines) || journalVoucherTotal(payload.lines) !== payload.total) {
      throw new DomainError('CLOSING_STALE', 409, `Sổ năm ${year} đã thay đổi từ khi lập đề xuất kết chuyển; hãy từ chối đề xuất này và lập lại`);
    }
    return postJournalVoucher(ctx, payload, year);
  },
});
