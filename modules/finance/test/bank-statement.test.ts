// Bank statement import (issue #326, ADR-0021 section 6): dates and amounts as banks print them, the file's order,
// the dedupe keys (the "+X, -X, +X" day the ADR left open), the classification against stored lines and the running
// balance check. The import itself is tested on PostgreSQL in apps/kernel/test/finance-bank.db.test.ts.
import { describe, expect, it } from 'vitest';
import { normalizeStatementAmount, type BankStatementRow } from '@crove/kernel-contract';
import { balanceBreaks, checkLines, checkStatement, classify, dedupeKeys, parseStatementAmount, parseStatementDate, readFeedLines, readStatement } from '../src/domain/bank-statement.ts';

let rowNo = 1;
const row = (date: string, moneyIn: string, moneyOut: string, balance = '', reference = '', description = 'Giao dịch'): BankStatementRow => ({
  rowNo: rowNo++,
  date,
  description,
  moneyIn,
  moneyOut,
  balance,
  reference,
});
const input = (rows: BankStatementRow[]) => ({ bankAccount: '1121', filename: 'sao-ke.xlsx', rows });
const none = { keys: new Set<string>(), dateAmounts: new Set<string>() };

describe('parseStatementDate', () => {
  it('reads Vietnamese dates, ISO dates and Excel serials', () => {
    expect(parseStatementDate('15/09/2026')).toBe('2026-09-15');
    expect(parseStatementDate('5/9/2026 14:03:22')).toBe('2026-09-05');
    expect(parseStatementDate('15-09-2026')).toBe('2026-09-15');
    expect(parseStatementDate('15.09.2026')).toBe('2026-09-15');
    expect(parseStatementDate('2026-09-15')).toBe('2026-09-15');
    expect(parseStatementDate('2026-09-15T08:00:00')).toBe('2026-09-15');
    // Excel: 46280 is 2026-09-15; a fraction is the time of day.
    expect(parseStatementDate('46280')).toBe('2026-09-15');
    expect(parseStatementDate('46280.6')).toBe('2026-09-15');
  });

  it('refuses what is not a day', () => {
    for (const bad of ['', '31/02/2026', '15/13/2026', '09/15/2026x', 'Tổng cộng', '1999-12-31', '1500000', '2026/09/15']) {
      expect(parseStatementDate(bad), bad).toBeNull();
    }
  });
});

describe('amounts', () => {
  it('normalizes printed amounts in the browser', () => {
    expect(normalizeStatementAmount('1.500.000')).toBe('1500000');
    expect(normalizeStatementAmount('1,500,000')).toBe('1500000');
    expect(normalizeStatementAmount('1,500,000.50')).toBe('1500000.50');
    expect(normalizeStatementAmount('1.500.000,50')).toBe('1500000.50');
    expect(normalizeStatementAmount(' 2 000 000 VND')).toBe('2000000');
    expect(normalizeStatementAmount('+11.000')).toBe('11000');
    expect(normalizeStatementAmount('-11,000')).toBe('-11000');
    expect(normalizeStatementAmount('12,5')).toBe('12.5');
    expect(normalizeStatementAmount('-')).toBe('');
    expect(normalizeStatementAmount('')).toBe('');
  });

  it('parses plain decimals with at most 2 decimals, within an amount column', () => {
    expect(parseStatementAmount('')).toEqual({ ok: true, value: null });
    expect(parseStatementAmount('1500000')).toMatchObject({ ok: true });
    expect(parseStatementAmount('1.5E+7')).toMatchObject({ ok: true });
    expect(parseStatementAmount('12.34')).toMatchObject({ ok: true });
    expect(parseStatementAmount('12.345')).toEqual({ ok: false });
    expect(parseStatementAmount('1e16')).toEqual({ ok: false });
    expect(parseStatementAmount('1.500.000')).toEqual({ ok: false });
    expect(parseStatementAmount('abc')).toEqual({ ok: false });
  });
});

describe('reading a statement', () => {
  it('signs amounts by side, and refuses rows without exactly one side', () => {
    const { parsed } = readStatement(
      input([row('01/09/2026', '500000', ''), row('02/09/2026', '', '-200000'), row('03/09/2026', '', ''), row('04/09/2026', '1', '2'), row('x', 'y', ''), row('05/09/2026', '1', '', 'z')]),
    );
    expect(parsed.map((p) => (p.ok ? p.amount : p.errors))).toEqual(['500000', '-200000', ['AMOUNT_MISSING'], ['AMOUNT_BOTH'], ['DATE_INVALID', 'AMOUNT_INVALID'], ['BALANCE_INVALID']]);
  });

  it('puts a newest-first file oldest first, by its dates or, on one day, by its balances', () => {
    const byDate = readStatement(input([row('03/09/2026', '1', ''), row('01/09/2026', '1', '')]));
    expect(byDate.order).toBe('newest_first');
    expect(byDate.lines.map((l) => l.date)).toEqual(['2026-09-01', '2026-09-03']);
    // One day, newest first: 100 -> +50 = 150 -> -30 = 120, listed 120, 150.
    const oneDay = readStatement(input([row('01/09/2026', '', '30', '120'), row('01/09/2026', '50', '', '150')]));
    expect(oneDay.order).toBe('newest_first');
    expect(oneDay.lines.map((l) => l.balance)).toEqual(['150', '120']);
  });

  it('keys by reference, else by date, amount, balance and occurrence, else none', () => {
    const { lines } = readStatement(
      input([
        row('01/09/2026', '11000', '', '111000', 'FT1'),
        // +X, -X, +X on one day: both +X lines keep their own key.
        row('01/09/2026', '5000', '', '116000'),
        row('01/09/2026', '', '5000', '111000'),
        row('01/09/2026', '5000', '', '116000'),
        row('02/09/2026', '1', ''),
      ]),
    );
    expect(dedupeKeys(lines)).toEqual(['ref:FT1', 'bal:2026-09-01|5000|116000|0', 'bal:2026-09-01|-5000|111000|0', 'bal:2026-09-01|5000|116000|1', null]);
  });

  it('classifies against stored keys and stored dates and amounts', () => {
    const { lines, keys } = readStatement(
      input([row('01/09/2026', '1', '', '', 'FT1'), row('01/09/2026', '1', '', '', 'FT1'), row('01/09/2026', '2', '', '', 'FT2'), row('02/09/2026', '3', ''), row('02/09/2026', '3', ''), row('03/09/2026', '4', '')]),
    );
    const stored = { keys: new Set(['ref:FT2']), dateAmounts: new Set(['2026-09-03|4']) };
    // A repeated reference in the file is a duplicate; identical keyless lines are each new; a keyless line matching a
    // stored line's date and amount is ambiguous.
    expect(classify(lines, keys, stored)).toEqual(['new', 'duplicate', 'duplicate', 'new', 'new', 'ambiguous']);
  });
});

describe('balanceBreaks', () => {
  it('reports each line whose balance does not follow, and carries the total over lines without one', () => {
    const line = (amount: string, balance: string | null, n: number | null = null) => ({ date: '2026-09-01', amount, balance, rowNo: n });
    expect(balanceBreaks([line('100', '100'), line('50', '150'), line('-20', null), line('10', '140')])).toEqual([]);
    expect(balanceBreaks([line('100', '100'), line('50', '160', 7), line('10', '170')])).toEqual([{ date: '2026-09-01', rowNo: 7, expected: '150', balance: '160' }]);
  });
});

describe('checkStatement', () => {
  it('stores only new and ambiguous lines, counts every row, and refuses a file with an invalid row', () => {
    const file = input([row('01/09/2026', '100', '', '100', 'A'), row('02/09/2026', '', '30', '70', 'B'), row('03/09/2026', '', '', '70')]);
    const check = checkStatement(file, { keys: new Set(['ref:A']), dateAmounts: new Set() }, { before: null, within: [] });
    expect(check.preview.counts).toEqual({ new: 1, duplicate: 1, ambiguous: 0, invalid: 1 });
    expect(check.preview.ok).toBe(false);
    expect(check.lines.map((l) => [l.reference, l.position, l.key])).toEqual([['B', 2, 'ref:B']]);
    expect(check.preview.from).toBe('2026-09-01');
    expect(check.preview.to).toBe('2026-09-02');
  });

  it('finds the line a mid-day overlap would drop: the running balance breaks after it', () => {
    // Stored (an import that ended at noon): +5000 -> 116000. Next file starts at noon: -5000 -> 111000, then +5000 ->
    // 116000 (a new line with the same date, amount, balance and occurrence as the stored one), then +1000 -> 117000.
    const file = input([row('01/09/2026', '', '5000', '111000'), row('01/09/2026', '5000', '', '116000'), row('01/09/2026', '1000', '', '117000')]);
    const stored = { keys: new Set(['bal:2026-09-01|5000|116000|0']), dateAmounts: new Set(['2026-09-01|5000']) };
    const check = checkStatement(file, stored, { before: { date: '2026-08-31', amount: '1', balance: '111000' }, within: [{ date: '2026-09-01', amount: '5000', balance: '116000' }] });
    expect(check.preview.counts).toMatchObject({ new: 2, duplicate: 1 });
    // The +1000 line lands on 112000 by the stored chain, not on its printed 117000: the break shows on the screen.
    expect(check.preview.breaks).toEqual([{ date: '2026-09-01', rowNo: file.rows[2]?.rowNo, expected: '112000', balance: '117000' }]);
  });

  it('accepts an exact overlapping re-import with no break', () => {
    const rows = [row('01/09/2026', '100', '', '100'), row('02/09/2026', '', '30', '70')];
    const first = checkStatement(input(rows), none, { before: null, within: [] });
    const stored = { keys: new Set(first.keys), dateAmounts: new Set(first.lines.map((l) => `${l.date}|${l.amount}`)) };
    const again = checkStatement(input([...rows, row('03/09/2026', '5', '', '75')]), stored, {
      before: null,
      within: first.lines.map((l) => ({ date: l.date, amount: l.amount, balance: l.balance })),
    });
    expect(again.preview.counts).toEqual({ new: 1, duplicate: 2, ambiguous: 0, invalid: 0 });
    expect(again.preview.breaks).toEqual([]);
    expect(again.lines.map((l) => l.position)).toEqual([3]);
  });
});

// A bank feed's lines (ADR-0039, #2044) go through the same keys and classification as a statement's.
describe('readFeedLines', () => {
  const line = (date: string, amount: string, reference: string | null, balance: string | null = null) => ({ date, description: ' Giao dịch ', amount, balance, reference });

  it('puts the lines oldest first, keeping the order within a day, and keys them as a statement', () => {
    const read = readFeedLines([line('2026-11-03', '-22000.00', 'FT2'), line('2026-11-02', '1000000', 'FT1'), line('2026-11-03', '5', null, '100.50')]);
    expect(read).toEqual({
      ok: true,
      lines: [
        { rowNo: 2, date: '2026-11-02', description: 'Giao dịch', amount: '1000000', balance: null, reference: 'FT1' },
        { rowNo: 1, date: '2026-11-03', description: 'Giao dịch', amount: '-22000', balance: null, reference: 'FT2' },
        { rowNo: 3, date: '2026-11-03', description: 'Giao dịch', amount: '5', balance: '100.5', reference: null },
      ],
      keys: ['ref:FT1', 'ref:FT2', 'bal:2026-11-03|5|100.5|0'],
    });
  });

  it('names every line whose amount is zero, too precise or too large, or whose balance is unreadable', () => {
    expect(readFeedLines([line('2026-11-02', '1', 'A'), line('2026-11-02', '0', 'B'), line('2026-11-02', '1.005', 'C'), line('2026-11-02', '1e16', 'D'), line('2026-11-02', '1', 'E', '0.001')])).toEqual({
      ok: false,
      rows: [2, 3, 4, 5],
    });
  });

  it('classifies a feed batch against the stored lines as a statement is', () => {
    const read = readFeedLines([line('2026-11-02', '1000', 'FT1'), line('2026-11-02', '2000', 'FT2'), line('2026-11-02', '2000', 'FT2')]);
    if (!read.ok) throw new Error('read');
    const checked = checkLines(read.lines, read.keys, { keys: new Set(['ref:FT1']), dateAmounts: new Set() }, { before: null, within: [] });
    expect(checked.statuses).toEqual(['duplicate', 'new', 'duplicate']);
    expect(checked.toStore.map((l) => [l.key, l.position])).toEqual([['ref:FT2', 2]]);
  });
});
