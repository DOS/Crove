// General journal vouchers (issue #888): phiếu kế toán khác, NVK. A voucher is a posting, so it follows the rules of
// every posting (plan §4.7: R3, P10 four-eyes, P11 fresh MFA, P12 eligible approvers):
// - finance.journal_voucher.prepare: a user enters a voucher through kernel.proposal.request, which runs this to check
//   it and build the proposal (each party as found, the total). It writes nothing. Owners, admins and members may ask.
// - finance.journal_voucher.record: runs only through kernel.proposal.approve, on the stored payload. It checks
//   everything again, inserts the voucher (the database numbers it per org, NVK00001 ...) and, in the same transaction,
//   posts its journal entry through the posting path, linked by source_type 'finance.journal_voucher'. The database
//   checks at commit (a deferred constraint trigger, 20261023150000) that the voucher has that entry, on its date.
// A voucher is corrected by reversing its entry (finance.journal.reverse); it keeps its number.
import { z } from 'zod';
import {
  JOURNAL_VOUCHER_COMMAND,
  JOURNAL_VOUCHER_KIND,
  journalVoucherCode,
  zJournalVoucherProposal,
  zJournalVoucherRequest,
  type JournalVoucherProposal,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { journalIsBalanced } from '@crove/l10n-vn';
import { assertUsableAccounts } from './accounts.ts';
import {
  JOURNAL_VOUCHER_LABEL,
  JOURNAL_VOUCHER_SOURCE,
  buildJournalVoucherJournal,
  journalVoucherEntryDescription,
  journalVoucherProblems,
  journalVoucherTitle,
  journalVoucherTotal,
  type JournalVoucherProblem,
} from './domain/journal-voucher.ts';
import { postJournalEntry } from './ledger.ts';
import { dateLabel, periodLockState } from './period-lock.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const PROBLEM_MESSAGES: Record<JournalVoucherProblem, string> = {
  LINE_SIDE: 'Mỗi dòng ghi một bên: Nợ hoặc Có, số tiền lớn hơn 0',
  UNBALANCED: 'Tổng phát sinh Nợ và tổng phát sinh Có phải bằng nhau',
  PARTY_REQUIRED: 'Dòng hạch toán vào 131 hoặc 331 cần chọn đối tượng (khách hàng hoặc nhà cung cấp)',
  TOTAL_TOO_LARGE: 'Tổng số tiền vượt quá giới hạn cho phép',
};

// Every check of a voucher, when it is asked for and again when it is posted: its shape, its accounts (in the org's
// chart and in use) and its parties (found in the org; read FOR SHARE when posting, so they stay as read until commit).
async function checkVoucher(ctx: QueryContext, lines: ReadonlyArray<{ account: string; partyId: string | null; debit: string; credit: string }>, lock: boolean) {
  const problems = journalVoucherProblems(lines);
  const first = problems[0];
  if (first) throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, PROBLEM_MESSAGES[first], { problems });
  await assertUsableAccounts(ctx, lines.map((l) => l.account));
  const ids = [...new Set(lines.flatMap((l) => (l.partyId ? [l.partyId] : [])))];
  const parties = new Map<string, { id: string; name: string; tax_code: string | null }>();
  if (ids.length > 0) {
    let query = ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name', 'tax_code']).where('org_id', '=', ctx.orgId).where('id', 'in', ids);
    if (lock) query = query.forShare();
    for (const p of await query.execute()) parties.set(p.id, p);
  }
  if (parties.size !== ids.length) throw new DomainError('PARTY_NOT_FOUND', 422, 'Không tìm thấy đối tượng đã chọn; hãy chọn lại');
  return parties;
}

export const prepareJournalVoucher = defineCommand({
  name: 'finance.journal_voucher.prepare',
  input: zJournalVoucherRequest,
  risk: 'R1',
  access: REQUESTERS,
  handler: async (ctx, input) => {
    const lines = input.lines.map((l) => ({ ...l, partyId: l.partyId ?? null }));
    const parties = await checkVoucher(ctx, lines, false);
    // A month already locked is refused now, while the user is still on the form; the posting guard refuses it again
    // when the proposal is approved, with a lock made since.
    const { lockedThrough } = await periodLockState(ctx);
    if (lockedThrough && input.date <= lockedThrough) {
      throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(input.date)}`, {
        lockedThrough,
        entryDate: input.date,
      });
    }
    const built: JournalVoucherProposal = {
      date: input.date,
      description: input.description.trim(),
      lines: lines.map((l) => {
        const party = l.partyId ? parties.get(l.partyId) : undefined;
        return {
          account: l.account,
          party: party ? { id: party.id, name: party.name, taxCode: party.tax_code } : null,
          debit: l.debit.replace(/^0+(?=\d)/, ''),
          credit: l.credit.replace(/^0+(?=\d)/, ''),
          ...(l.memo?.trim() ? { memo: l.memo.trim() } : {}),
        };
      }),
      total: journalVoucherTotal(lines),
    };
    // The payload is stored as the proposal and parsed again with this schema when it is approved. One the schema
    // refuses (a party whose stored name is longer than a voucher holds, say) could never be approved, so it is
    // refused now.
    const parsed = zJournalVoucherProposal.safeParse(built);
    if (!parsed.success) {
      throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Không lập được phiếu kế toán từ dữ liệu này; hãy kiểm tra lại đối tượng và các dòng hạch toán', {
        problems: ['PROPOSAL_INVALID'],
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
      });
    }
    const payload = parsed.data;
    return { kind: JOURNAL_VOUCHER_KIND, command: JOURNAL_VOUCHER_COMMAND, title: journalVoucherTitle(payload), payload };
  },
});

// Inserts the voucher (the database numbers it) and posts its entry, in the command's transaction: the approval of a
// general journal voucher, and of a year-end closing (year-closing.ts, closingYear set). The payload has been checked.
export async function postJournalVoucher(ctx: CommandContext, payload: JournalVoucherProposal, closingYear: number | null = null) {
  if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
  const total = journalVoucherTotal(payload.lines);
  const journal = buildJournalVoucherJournal(payload);
  if (!journalIsBalanced(journal)) throw new DomainError('UNBALANCED', 422, 'Bút toán không cân');
  const voucher = await ctx.trx
    .insertInto('crove_finance.journal_voucher')
    .values({
      org_id: ctx.orgId,
      voucher_date: payload.date,
      description: payload.description,
      proposal_id: ctx.proposalId,
      closing_year: closingYear,
      created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
    })
    .returning(['id', 'number'])
    .executeTakeFirstOrThrow();
  const code = journalVoucherCode(voucher.number);
  const journalEntryId = await postJournalEntry(ctx, {
    entryDate: payload.date,
    description: journalVoucherEntryDescription(code, payload.description),
    sourceType: JOURNAL_VOUCHER_SOURCE,
    sourceId: voucher.id,
    beforeOpening: 'later_date',
    lines: journal.map((j, i) => ({
      lineNo: j.lineNo,
      accountCode: j.accountCode,
      debit: j.debit,
      credit: j.credit,
      partyId: payload.lines[i]?.party?.id ?? null,
      memo: j.memo,
    })),
  });
  ctx.audit({ number: voucher.number, total, lines: payload.lines.length, ...(closingYear ? { closingYear } : {}) });
  await ctx.activity('finance.journal_voucher', voucher.id, 'journal_voucher.recorded', `Ghi sổ ${JOURNAL_VOUCHER_LABEL.toLowerCase()} ${code}: ${payload.description}`);
  await ctx.emit('finance.journal_voucher.recorded', { voucherId: voucher.id, journalEntryId, number: voucher.number });
  return { voucherId: voucher.id, journalEntryId, code };
}

export const recordJournalVoucher = defineCommand({
  name: JOURNAL_VOUCHER_COMMAND,
  input: z.object({ payload: zJournalVoucherProposal, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  access: 'proposal',
  proposalKind: JOURNAL_VOUCHER_KIND,
  handler: async (ctx, { payload }) => {
    if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const lines = payload.lines.map((l) => ({ account: l.account, partyId: l.party?.id ?? null, debit: l.debit, credit: l.credit }));
    // The stored payload is checked as if new: a sub-account deactivated or a party gone since it was asked for is
    // refused here. The total is the lines' sum, never taken from the payload as is.
    await checkVoucher(ctx, lines, true);
    if (journalVoucherTotal(lines) !== payload.total) {
      throw new DomainError('JOURNAL_VOUCHER_INVALID', 422, 'Tổng số tiền không khớp các dòng của phiếu', { problems: ['TOTAL_MISMATCH'] });
    }
    return postJournalVoucher(ctx, payload);
  },
});
