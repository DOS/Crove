// The general journal voucher form (NVK, #888): what the SPA refuses before it asks, and the refusals it words.
import { describe, expect, it } from 'vitest';
import { journalAmount, journalFormProblem, journalTotals, journalVoucherProblem, type JournalFormLine } from '../src/lib/journal-voucher.ts';

const line = (account: string, debit: string, credit: string, partyId = ''): JournalFormLine => ({ account, partyId, debit, credit });

describe('general journal voucher form', () => {
  it('reads amounts as typed, grouped by dots, spaces or commas, and an empty side as 0', () => {
    expect(journalAmount('1.500.000')).toBe('1500000');
    expect(journalAmount('1 500 000')).toBe('1500000');
    expect(journalAmount('')).toBe('0');
    expect(journalAmount('12,5a')).toBe('12,5a');
    expect(journalTotals([line('6422', '1.500.000', ''), line('331', '', '1.500.000'), line('6421', 'x', '')])).toEqual({ debit: '1500000', credit: '1500000' });
  });

  it('accepts a balanced voucher and names the first problem of one that is not', () => {
    const ok = { date: '2026-10-31', description: 'Trích trước lương', lines: [line('6422', '1.000', ''), line('334', '', '1.000')] };
    expect(journalFormProblem(ok)).toBeNull();
    expect(journalFormProblem({ ...ok, description: '  ' })).toBe('description');
    expect(journalFormProblem({ ...ok, lines: [line('6422', '1000', '')] })).toBe('lines');
    expect(journalFormProblem({ ...ok, lines: [line('6422', '1x', ''), line('334', '', '1000')] })).toBe('amount');
    expect(journalFormProblem({ ...ok, lines: [line('6422', '1000', '1000'), line('334', '', '1000')] })).toBe('side');
    expect(journalFormProblem({ ...ok, lines: [line('6422', '', ''), line('334', '', '1000')] })).toBe('side');
    expect(journalFormProblem({ ...ok, lines: [line('6422', '1000', ''), line('331', '', '1000')] })).toBe('party');
    expect(journalFormProblem({ ...ok, lines: [line('6422', '1000', ''), line('3311', '', '1000', 'p1')] })).toBeNull();
    expect(journalFormProblem({ ...ok, lines: [line('6422', '1000', ''), line('334', '', '900')] })).toBe('unbalanced');
  });

  it('names the problem of a JOURNAL_VOUCHER_INVALID refusal, and nothing for other errors', () => {
    expect(journalVoucherProblem({ code: 'JOURNAL_VOUCHER_INVALID', data: { problems: ['UNBALANCED'] } })).toBe('UNBALANCED');
    expect(journalVoucherProblem({ code: 'JOURNAL_VOUCHER_INVALID', data: { problems: ['SOMETHING_NEW'] } })).toBeNull();
    expect(journalVoucherProblem({ code: 'VOUCHER_INVALID', data: { problems: ['UNBALANCED'] } })).toBeNull();
    expect(journalVoucherProblem(null)).toBeNull();
  });
});
