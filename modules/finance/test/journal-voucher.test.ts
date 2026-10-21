// General journal vouchers (NVK, #888) as pure functions: the problems, the total, the journal and the title.
import { describe, expect, it } from 'vitest';
import {
  buildJournalVoucherJournal,
  journalVoucherEntryDescription,
  journalVoucherProblems,
  journalVoucherTitle,
  journalVoucherTotal,
} from '../src/domain/journal-voucher.ts';

const line = (account: string, debit: string, credit: string, partyId: string | null = null) => ({ account, debit, credit, partyId });

describe('general journal voucher', () => {
  it('finds no problem in a balanced voucher, and each problem of one that is not', () => {
    expect(journalVoucherProblems([line('6422', '1500000', '0'), line('331', '0', '1500000', 'p1')])).toEqual([]);
    expect(journalVoucherProblems([line('6422', '100', '100'), line('331', '0', '0', 'p1')])).toEqual(['LINE_SIDE']);
    expect(journalVoucherProblems([line('6422', '100', '0'), line('214', '0', '90')])).toEqual(['UNBALANCED']);
    expect(journalVoucherProblems([line('1311', '100', '0'), line('511', '0', '100')])).toEqual(['PARTY_REQUIRED']);
    expect(journalVoucherProblems([line('6422', '999999999999999', '0'), line('6421', '1', '0'), line('214', '0', '999999999999999'), line('214', '0', '1')])).toEqual([
      'TOTAL_TOO_LARGE',
    ]);
  });

  it('builds the journal line by line, each with its own memo or the reason', () => {
    const voucher = {
      description: 'Khấu hao tháng 10',
      lines: [
        { account: '6422', party: null, debit: '0800000', credit: '0', memo: 'Máy tính' },
        { account: '214', party: null, debit: '0', credit: '800000' },
      ],
    };
    expect(buildJournalVoucherJournal(voucher)).toEqual([
      { lineNo: 1, accountCode: '6422', debit: '800000', credit: '0', memo: 'Máy tính' },
      { lineNo: 2, accountCode: '214', debit: '0', credit: '800000', memo: 'Khấu hao tháng 10' },
    ]);
    expect(journalVoucherTotal(voucher.lines)).toBe('800000');
  });

  it('describes the entry by its code and titles the proposal by its amount', () => {
    expect(journalVoucherEntryDescription('NVK00012', 'Khấu hao tháng 10')).toBe('NVK00012 Khấu hao tháng 10');
    expect(journalVoucherTitle({ total: '12000000', description: 'Trích trước lương tháng 10' })).toBe('Phiếu kế toán 12.000.000 đ: Trích trước lương tháng 10');
  });
});
