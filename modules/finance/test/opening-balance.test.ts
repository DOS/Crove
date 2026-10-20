// Opening balances from Excel (issue #320): the pure check of a trial balance, its money edge cases and the lines of
// the opening entry. The database side (posting, one opening entry per org, RLS) is in
// apps/kernel/test/finance-opening-balance.db.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeAmountText, type OpeningBalanceImport, type OpeningBalanceRow } from '@crove/kernel-contract';
import { money, sum } from '@crove/l10n-vn';
import { checkOpeningBalance, parseOpeningAmount, type OpeningChartAccount, type LedgerFacts } from '../src/index.ts';

const CHART: ReadonlyMap<string, OpeningChartAccount> = new Map(
  [
    ['111', 'Tiền mặt'],
    ['112', 'Tiền gửi ngân hàng'],
    ['131', 'Phải thu của khách hàng'],
    ['331', 'Phải trả cho người bán'],
    ['411', 'Vốn đầu tư của chủ sở hữu'],
    ['421', 'Lợi nhuận sau thuế chưa phân phối'],
  ].map(([code, name]) => [code as string, { code: code as string, name: name as string, active: true }]),
);
const EMPTY_LEDGER: LedgerFacts = { openingEntry: null, firstEntryDate: null };

let rowNo = 1;
const row = (accountCode: string, debit: string, credit: string, accountName = ''): OpeningBalanceRow => ({
  rowNo: ++rowNo,
  accountCode,
  accountName,
  debit,
  credit,
});
// A 131 or 331 row of one customer or vendor (#689). Tax codes are the repo's checksum-invalid fixtures.
const partyRow = (accountCode: string, debit: string, credit: string, partyTaxCode?: string, partyName?: string): OpeningBalanceRow => ({
  ...row(accountCode, debit, credit),
  ...(partyTaxCode !== undefined ? { partyTaxCode } : {}),
  ...(partyName !== undefined ? { partyName } : {}),
});
const input = (rows: OpeningBalanceRow[], asOf = '2025-12-31'): OpeningBalanceImport => ({ asOf, rows });

describe('parseOpeningAmount', () => {
  it('reads whole VND from number cells and normalized text cells', () => {
    expect(parseOpeningAmount('')).toEqual({ ok: true, value: '0' });
    expect(parseOpeningAmount('  ')).toEqual({ ok: true, value: '0' });
    expect(parseOpeningAmount('0')).toEqual({ ok: true, value: '0' });
    expect(parseOpeningAmount('-0')).toEqual({ ok: true, value: '0' });
    expect(parseOpeningAmount('1500000')).toEqual({ ok: true, value: '1500000' });
    // Trailing zeros after a point still name a whole amount.
    expect(parseOpeningAmount('1500000.000')).toEqual({ ok: true, value: '1500000' });
    // Excel writes large numbers with an exponent.
    expect(parseOpeningAmount('1.5E+7')).toEqual({ ok: true, value: '15000000' });
    expect(parseOpeningAmount('9999999999999999')).toEqual({ ok: true, value: '9999999999999999' });
  });

  it('refuses fractions, negatives, overflow and text that is not a number', () => {
    expect(parseOpeningAmount('0.5')).toEqual({ ok: false, error: 'AMOUNT_FRACTION' });
    expect(parseOpeningAmount('1500000.0000000002')).toEqual({ ok: false, error: 'AMOUNT_FRACTION' });
    expect(parseOpeningAmount('1E-9999')).toEqual({ ok: false, error: 'AMOUNT_FRACTION' });
    expect(parseOpeningAmount('-1')).toEqual({ ok: false, error: 'AMOUNT_NEGATIVE' });
    expect(parseOpeningAmount('10000000000000000')).toEqual({ ok: false, error: 'AMOUNT_TOO_LARGE' });
    expect(parseOpeningAmount('1E+9999')).toEqual({ ok: false, error: 'AMOUNT_TOO_LARGE' });
    for (const text of ['abc', '1,5', '1.500,00', '(1000)', '1e', 'Infinity', 'NaN', '0x10', '1E+99999', '+5']) {
      expect(parseOpeningAmount(text), text).toEqual({ ok: false, error: 'AMOUNT_INVALID' });
    }
  });

  it('agrees with the text normalization of the template', () => {
    expect(normalizeAmountText('1.500.000')).toBe('1500000');
    expect(normalizeAmountText('1,500,000')).toBe('1500000');
    expect(normalizeAmountText(' 1 500 000 ')).toBe('1500000');
    expect(normalizeAmountText('1 500 000')).toBe('1500000');
    expect(normalizeAmountText('-')).toBe('');
    // Mixed or uneven separators are left for the module to refuse.
    expect(normalizeAmountText('1.500,000')).toBe('1.500,000');
    expect(normalizeAmountText('1.5')).toBe('1.5');
    // A leading zero is not a thousands group.
    expect(normalizeAmountText('0.500')).toBe('0.500');
    expect(parseOpeningAmount(normalizeAmountText('0.500'))).toEqual({ ok: false, error: 'AMOUNT_FRACTION' });
    expect(parseOpeningAmount(normalizeAmountText('1.5'))).toEqual({ ok: false, error: 'AMOUNT_FRACTION' });
    expect(parseOpeningAmount(normalizeAmountText('1.500,000'))).toEqual({ ok: false, error: 'AMOUNT_INVALID' });
  });
});

describe('checkOpeningBalance', () => {
  it('turns a balanced trial balance into one line per side with an amount, in row order', () => {
    const { preview, lines } = checkOpeningBalance(
      input([
        row('111', '50000000', ''),
        row('112', '150000000', '0'),
        // A heading or an account with no balance is skipped, whatever its code.
        row('', '', '', 'TÀI SẢN'),
        row('999', '', ''),
        // Customers owing and customers who paid in advance: both sides are kept.
        row('131', '30000000', '5000000'),
        row('331', '', '25000000'),
        row('411', '', '200000000'),
      ]),
      CHART,
      EMPTY_LEDGER,
    );
    expect(preview.ok).toBe(true);
    expect(preview.errors).toEqual([]);
    expect(preview.totals).toEqual({ debit: '230000000', credit: '230000000', difference: '0' });
    expect(preview.rows.map((r) => r.skipped)).toEqual([false, false, true, true, false, false, false]);
    expect(preview.rows[0]?.accountName).toBe('Tiền mặt');
    expect(lines).toEqual([
      { lineNo: 1, accountCode: '111', debit: '50000000', credit: '0', party: null },
      { lineNo: 2, accountCode: '112', debit: '150000000', credit: '0', party: null },
      { lineNo: 3, accountCode: '131', debit: '30000000', credit: '0', party: null },
      { lineNo: 4, accountCode: '131', debit: '0', credit: '5000000', party: null },
      { lineNo: 5, accountCode: '331', debit: '0', credit: '25000000', party: null },
      { lineNo: 6, accountCode: '411', debit: '0', credit: '200000000', party: null },
    ]);
    expect(preview.lines).toBe(6);
  });

  it('refuses a difference of a single dong', () => {
    const { preview, lines } = checkOpeningBalance(input([row('111', '100000001', ''), row('411', '', '100000000')]), CHART, EMPTY_LEDGER);
    expect(preview.ok).toBe(false);
    expect(preview.errors).toEqual(['UNBALANCED']);
    expect(preview.totals.difference).toBe('1');
    expect(lines).toEqual([]);
    expect(preview.lines).toBe(0);
  });

  it('sums amounts past what a JS number holds exactly', () => {
    // 2^53 + 1: as a double it reads 2^53, and 2^53 + 1 again; the decimal sum stays exact.
    const exact = checkOpeningBalance(
      input([row('111', '9007199254740993', ''), row('112', '1', ''), row('411', '', '9007199254740994')]),
      CHART,
      EMPTY_LEDGER,
    );
    expect(exact.preview.ok).toBe(true);
    expect(exact.preview.totals).toEqual({ debit: '9007199254740994', credit: '9007199254740994', difference: '0' });
    // A total may exceed what one line holds while every line fits.
    const many = checkOpeningBalance(
      input([row('111', '9999999999999999', ''), row('112', '9999999999999999', ''), row('331', '', '9999999999999999'), row('411', '', '9999999999999999')]),
      CHART,
      EMPTY_LEDGER,
    );
    expect(many.preview.ok).toBe(true);
    expect(many.preview.totals).toEqual({ debit: '19999999999999998', credit: '19999999999999998', difference: '0' });
    // An invalid amount counts for nothing in the totals.
    const tooLarge = checkOpeningBalance(input([row('111', '10000000000000000', ''), row('411', '', '1')]), CHART, EMPTY_LEDGER);
    expect(tooLarge.preview.rows[0]?.errors).toEqual(['AMOUNT_TOO_LARGE']);
    expect(tooLarge.preview.totals).toEqual({ debit: '0', credit: '1', difference: '-1' });
  });

  it('flags unknown, missing and duplicate accounts and bad amounts on their rows', () => {
    const { preview } = checkOpeningBalance(
      input([
        row('111', '100', ''),
        row('1119', '100', ''),
        row('', '', '100'),
        row('112', '1,5', ''),
        row('331', '-100', ''),
        row('411', '', '100'),
        row('411', '', '100'),
        row('421', '0.5', ''),
      ]),
      CHART,
      EMPTY_LEDGER,
    );
    expect(preview.ok).toBe(false);
    expect(preview.rows.map((r) => r.errors)).toEqual([
      [],
      ['ACCOUNT_UNKNOWN'],
      ['ACCOUNT_MISSING'],
      ['AMOUNT_INVALID'],
      ['AMOUNT_NEGATIVE'],
      ['ACCOUNT_DUPLICATE'],
      ['ACCOUNT_DUPLICATE'],
      ['AMOUNT_FRACTION'],
    ]);
    expect(preview.rows[3]?.debit).toBeNull();
  });

  it('refuses an inactive account', () => {
    const chart = new Map(CHART);
    chart.set('112', { code: '112', name: 'Tiền gửi ngân hàng', active: false });
    const { preview } = checkOpeningBalance(input([row('112', '100', ''), row('411', '', '100')]), chart, EMPTY_LEDGER);
    expect(preview.rows[0]?.errors).toEqual(['ACCOUNT_INACTIVE']);
    expect(preview.ok).toBe(false);
  });

  it('refuses an empty sheet', () => {
    expect(checkOpeningBalance(input([]), CHART, EMPTY_LEDGER).preview.errors).toEqual(['NO_BALANCES']);
    expect(checkOpeningBalance(input([row('111', '', '')]), CHART, EMPTY_LEDGER).preview.errors).toEqual(['NO_BALANCES']);
  });

  it('refuses a second opening entry and a date on or after the first other entry', () => {
    const rows = [row('111', '100', ''), row('411', '', '100')];
    const existing = checkOpeningBalance(input(rows), CHART, { openingEntry: { id: 'e-1', entryDate: '2025-12-31' }, firstEntryDate: null });
    expect(existing.preview.errors).toEqual(['OPENING_EXISTS']);
    expect(existing.preview.openingEntry).toEqual({ id: 'e-1', entryDate: '2025-12-31' });
    expect(checkOpeningBalance(input(rows, '2026-01-05'), CHART, { openingEntry: null, firstEntryDate: '2026-01-05' }).preview.errors).toEqual(['AFTER_ENTRIES']);
    expect(checkOpeningBalance(input(rows, '2026-02-01'), CHART, { openingEntry: null, firstEntryDate: '2026-01-05' }).preview.errors).toEqual(['AFTER_ENTRIES']);
    expect(checkOpeningBalance(input(rows, '2026-01-04'), CHART, { openingEntry: null, firstEntryDate: '2026-01-05' }).preview.ok).toBe(true);
  });

  it('splits receivables and payables per party, with an unallocated rest, and carries the party to the lines (#689)', () => {
    const { preview, lines } = checkOpeningBalance(
      input([
        partyRow('131', '30000000', '', ' 0101.234.564 ', 'Công ty Khách A'),
        partyRow('131', '10000000', '', '0309876546-001'),
        // A customer without a tax code, by name; spaces are tidied.
        partyRow('131', '2000000', '', '', '  Khách  lẻ '),
        // The rest of 131 that the firm cannot split.
        row('131', '8000000', ''),
        partyRow('331', '', '25000000', '0312345670', 'NCC B'),
        row('411', '', '25000000'),
      ]),
      CHART,
      EMPTY_LEDGER,
    );
    expect(preview.ok).toBe(true);
    expect(preview.rows.map((r) => [r.partyTaxCode, r.partyName])).toEqual([
      ['0101234564', 'Công ty Khách A'],
      ['0309876546-001', null],
      [null, 'Khách lẻ'],
      [null, null],
      ['0312345670', 'NCC B'],
      [null, null],
    ]);
    expect(lines.map((l) => [l.accountCode, l.debit, l.credit, l.party])).toEqual([
      ['131', '30000000', '0', { taxCode: '0101234564', name: 'Công ty Khách A' }],
      ['131', '10000000', '0', { taxCode: '0309876546-001', name: '' }],
      ['131', '2000000', '0', { taxCode: null, name: 'Khách lẻ' }],
      ['131', '8000000', '0', null],
      ['331', '0', '25000000', { taxCode: '0312345670', name: 'NCC B' }],
      ['411', '0', '25000000', null],
    ]);
  });

  it('flags the same account and party twice, a party off 131 and 331, and a tax code that is not one (#689)', () => {
    const { preview, lines } = checkOpeningBalance(
      input([
        // The same customer written two ways is one party: both rows are flagged.
        partyRow('131', '1000000', '', '0101234564'),
        partyRow('131', '2000000', '', '0101 234 564', 'Công ty Khách A'),
        // The same name without a tax code, case aside.
        partyRow('331', '', '1000000', '', 'NCC Lẻ'),
        partyRow('331', '', '1000000', '', 'ncc lẻ'),
        // Two unallocated rows of one account are a duplicate as before.
        row('331', '', '500000'),
        row('331', '', '500000'),
        partyRow('111', '1000000', '', '0101234564'),
        partyRow('131', '1000000', '', 'MST-123'),
        row('411', '', '2000000'),
      ]),
      CHART,
      EMPTY_LEDGER,
    );
    expect(preview.ok).toBe(false);
    expect(lines).toEqual([]);
    expect(preview.rows.map((r) => r.errors)).toEqual([
      ['ACCOUNT_DUPLICATE'],
      ['ACCOUNT_DUPLICATE'],
      ['ACCOUNT_DUPLICATE'],
      ['ACCOUNT_DUPLICATE'],
      ['ACCOUNT_DUPLICATE'],
      ['ACCOUNT_DUPLICATE'],
      ['PARTY_NOT_ALLOWED'],
      ['PARTY_TAX_CODE_INVALID'],
      [],
    ]);
    // An invalid code is shown as written, so the row can be found and fixed.
    expect(preview.rows[7]?.partyTaxCode).toBe('MST-123');
  });

  it('allows a party on a sub-account of 131 or 331 and ignores the party of a row with no balance (#689)', () => {
    const chart = new Map(CHART).set('1311.VCB', { code: '1311.VCB', name: 'Phải thu chi tiết', active: true });
    const { preview } = checkOpeningBalance(
      input([partyRow('1311.VCB', '1000000', '', '0101234564'), partyRow('112', '', '', '0101234564'), row('411', '', '1000000')]),
      chart,
      EMPTY_LEDGER,
    );
    expect(preview.ok).toBe(true);
    expect(preview.rows.map((r) => r.skipped)).toEqual([false, true, false]);
  });

  it('posts exactly when every row is clean and the totals match, and the lines always balance', () => {
    const amount = fc.oneof(fc.constant(''), fc.bigInt({ min: 0n, max: 10n ** 15n }).map(String));
    const sheet = fc.array(fc.record({ code: fc.constantFrom(...CHART.keys()), debit: amount, credit: amount }), { maxLength: 6 });
    fc.assert(
      fc.property(sheet, (cells) => {
        const rows = cells.map((c) => row(c.code, c.debit, c.credit));
        const { preview, lines } = checkOpeningBalance(input(rows), CHART, EMPTY_LEDGER);
        const debit = sum(rows.map((r) => r.debit || '0'));
        const credit = sum(rows.map((r) => r.credit || '0'));
        const used = rows.filter((r) => money(r.debit || '0').plus(money(r.credit || '0')).greaterThan(0)).map((r) => r.accountCode);
        const expected = used.length > 0 && new Set(used).size === used.length && debit.equals(credit);
        expect(preview.ok).toBe(expected);
        if (preview.ok) {
          expect(sum(lines.map((l) => l.debit)).equals(sum(lines.map((l) => l.credit)))).toBe(true);
          expect(lines.every((l) => (l.debit === '0') !== (l.credit === '0'))).toBe(true);
        } else {
          expect(lines).toEqual([]);
        }
      }),
      { seed: 320, numRuns: 200 },
    );
  });
});
