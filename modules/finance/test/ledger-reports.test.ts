// Ledger reports (issue #321): the trial balance with sub-accounts rolled up and 131/331 balances per party, the
// general ledger with its running balance and counter accounts, receivables and payables per party, and the periods.
import { describe, expect, it } from 'vitest';
import {
  accountLedger,
  ledgerPeriod,
  partyLedger,
  trialBalance,
  type ChartAccount,
  type OpeningBalance,
  type PartyInfo,
  type PeriodLine,
} from '../src/index.ts';

const CHART: ChartAccount[] = [
  { code: '111', name: 'Tiền mặt', parentCode: null },
  { code: '131', name: 'Phải thu của khách hàng', parentCode: null },
  { code: '133', name: 'Thuế GTGT được khấu trừ', parentCode: null },
  { code: '1331', name: 'Thuế GTGT được khấu trừ của hàng hóa, dịch vụ', parentCode: '133' },
  { code: '1332', name: 'Thuế GTGT được khấu trừ của TSCĐ', parentCode: '133' },
  { code: '331', name: 'Phải trả cho người bán', parentCode: null },
  { code: '333', name: 'Thuế và các khoản phải nộp Nhà nước', parentCode: null },
  { code: '3331', name: 'Thuế giá trị gia tăng phải nộp', parentCode: '333' },
  { code: '411', name: 'Vốn đầu tư của chủ sở hữu', parentCode: null },
  { code: '511', name: 'Doanh thu bán hàng và cung cấp dịch vụ', parentCode: null },
  { code: '642', name: 'Chi phí quản lý kinh doanh', parentCode: null },
  { code: '6422', name: 'Chi phí quản lý doanh nghiệp', parentCode: '642' },
];

const V1 = '00000000-0000-7000-8000-000000000001';
const V2 = '00000000-0000-7000-8000-000000000002';
const C1 = '00000000-0000-7000-8000-000000000003';
const PARTIES = new Map<string, PartyInfo>([
  [V1, { name: 'Công ty B', taxCode: '0100000001' }],
  [V2, { name: 'Công ty A', taxCode: '0100000002' }],
  [C1, { name: 'Khách hàng C', taxCode: null }],
]);

// Before September: a purchase from V1 (1,100,000 owed), an advance of 500,000 to V2, the owner's capital.
const OPENING: OpeningBalance[] = [
  { accountCode: '111', partyId: null, debit: '2000000', credit: '500000' },
  { accountCode: '1331', partyId: null, debit: '100000', credit: '0' },
  { accountCode: '331', partyId: V1, debit: '0', credit: '1100000' },
  { accountCode: '331', partyId: V2, debit: '500000', credit: '0' },
  { accountCode: '411', partyId: null, debit: '0', credit: '2000000' },
  { accountCode: '6422', partyId: null, debit: '1000000', credit: '0' },
];

let lineNo = 0;
function line(entryId: string, entryDate: string, accountCode: string, debit: string, credit: string, partyId: string | null = null, reversal = false): PeriodLine {
  lineNo += 1;
  return { entryId, entryDate, reference: null, description: `Bút toán ${entryId}`, reversal, lineNo, accountCode, partyId, debit, credit };
}

// September: E1 a purchase from V1, E2 paying V1's opening debt, E3 a sale to C1, E4 the reversal of E1.
const LINES: PeriodLine[] = [
  line('e1', '2026-09-05', '6422', '2000000', '0'),
  line('e1', '2026-09-05', '1331', '200000', '0'),
  line('e1', '2026-09-05', '331', '0', '2200000', V1),
  line('e2', '2026-09-10', '331', '1100000', '0', V1),
  line('e2', '2026-09-10', '111', '0', '1100000'),
  line('e3', '2026-09-20', '131', '3300000', '0', C1),
  line('e3', '2026-09-20', '511', '0', '3000000'),
  line('e3', '2026-09-20', '3331', '0', '300000'),
  line('e4', '2026-09-30', '6422', '0', '2000000', null, true),
  line('e4', '2026-09-30', '1331', '0', '200000', null, true),
  line('e4', '2026-09-30', '331', '2200000', '0', V1, true),
];

describe('ledgerPeriod', () => {
  it('reads a month, a quarter and a year', () => {
    expect(ledgerPeriod('2026-09')).toEqual({ period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    expect(ledgerPeriod('2028-02')).toMatchObject({ to: '2028-02-29' });
    expect(ledgerPeriod('2026-Q4')).toEqual({ period: '2026-Q4', kind: 'quarter', from: '2026-10-01', to: '2026-12-31' });
    expect(ledgerPeriod('2026')).toEqual({ period: '2026', kind: 'year', from: '2026-01-01', to: '2026-12-31' });
  });

  it('refuses anything else', () => {
    for (const period of ['2026-13', '2026-Q5', '2026-9', '1999', '26', '', '2026-09-01']) expect(() => ledgerPeriod(period), period).toThrow();
  });
});

describe('trialBalance', () => {
  const tb = trialBalance(CHART, OPENING, LINES);
  const row = (code: string) => tb.rows.find((r) => r.accountCode === code);

  it('lists each account with activity, then its sub-accounts, and leaves out the rest', () => {
    expect(tb.rows.map((r) => [r.accountCode, r.level, r.parentCode])).toEqual([
      ['111', 0, null],
      ['131', 0, null],
      ['133', 0, null],
      ['1331', 1, '133'],
      ['331', 0, null],
      ['333', 0, null],
      ['3331', 1, '333'],
      ['411', 0, null],
      ['511', 0, null],
      ['642', 0, null],
      ['6422', 1, '642'],
    ]);
    expect(row('1332')).toBeUndefined();
    expect(row('133')?.accountName).toBe('Thuế GTGT được khấu trừ');
  });

  it('computes opening, period and closing amounts, net per account', () => {
    expect(row('111')).toMatchObject({ openingDebit: '1500000', openingCredit: '0', debit: '0', credit: '1100000', closingDebit: '400000', closingCredit: '0' });
    expect(row('411')).toMatchObject({ openingDebit: '0', openingCredit: '2000000', closingCredit: '2000000' });
    // The reversal counts as posted: E1 and E4 both show in the period's debits and credits, and net out.
    expect(row('6422')).toMatchObject({ openingDebit: '1000000', debit: '2000000', credit: '2000000', closingDebit: '1000000', closingCredit: '0' });
  });

  it('rolls sub-accounts up into their parents', () => {
    const amounts = (code: string) => {
      const r = row(code);
      return r && [r.openingDebit, r.openingCredit, r.debit, r.credit, r.closingDebit, r.closingCredit];
    };
    expect(amounts('133')).toEqual(amounts('1331'));
    expect(amounts('133')).toEqual(['100000', '0', '200000', '200000', '100000', '0']);
    expect(amounts('333')).toEqual(['0', '0', '0', '300000', '0', '300000']);
    expect(amounts('642')).toEqual(amounts('6422'));
  });

  it('adds a parent account own lines to those of its sub-accounts', () => {
    const own = trialBalance(CHART, [], [line('x', '2026-09-01', '133', '50', '0'), line('x', '2026-09-01', '1332', '25', '0'), line('x', '2026-09-01', '111', '0', '75')]);
    expect(own.rows.map((r) => [r.accountCode, r.debit])).toEqual([
      ['111', '0'],
      ['133', '75'],
      ['1332', '25'],
    ]);
  });

  it('nets a parent whose sub-accounts have balances on opposite sides', () => {
    const opposite = trialBalance(
      CHART,
      [
        { accountCode: '1331', partyId: null, debit: '100', credit: '0' },
        { accountCode: '1332', partyId: null, debit: '0', credit: '30' },
        { accountCode: '111', partyId: null, debit: '0', credit: '70' },
      ],
      [],
    );
    const sides = (code: string) => {
      const r = opposite.rows.find((x) => x.accountCode === code);
      return r && [r.openingDebit, r.openingCredit, r.closingDebit, r.closingCredit];
    };
    expect(sides('1331')).toEqual(['100', '0', '100', '0']);
    expect(sides('1332')).toEqual(['0', '30', '0', '30']);
    expect(sides('133')).toEqual(['70', '0', '70', '0']);
    expect(opposite.totals).toMatchObject({ openingDebit: '70', openingCredit: '70', closingDebit: '70', closingCredit: '70' });
    expect(opposite.balanced).toBe(true);
  });

  it('shows payable and receivable balances per party: an advance to a vendor stays a debit balance', () => {
    expect(row('331')).toMatchObject({ openingDebit: '500000', openingCredit: '1100000', debit: '3300000', credit: '2200000', closingDebit: '500000', closingCredit: '0' });
    expect(row('131')).toMatchObject({ openingDebit: '0', debit: '3300000', closingDebit: '3300000' });
  });

  it('balances: opening, period and closing debits equal credits', () => {
    expect(tb.totals).toEqual({
      openingDebit: '3100000',
      openingCredit: '3100000',
      debit: '8800000',
      credit: '8800000',
      closingDebit: '5300000',
      closingCredit: '5300000',
    });
    expect(tb.balanced).toBe(true);
    expect(trialBalance(CHART, [{ accountCode: '111', partyId: null, debit: '1', credit: '0' }], []).balanced).toBe(false);
  });

  it('keeps amounts exact beyond what a double holds', () => {
    const big = '9007199254740993';
    const exact = trialBalance(CHART, [], [line('b', '2026-09-01', '111', big, '0'), line('b', '2026-09-01', '111', '0.5', '0'), line('b', '2026-09-01', '411', '0', '9007199254740993.5')]);
    expect(exact.rows.find((r) => r.accountCode === '111')).toMatchObject({ debit: '9007199254740993.5', closingDebit: '9007199254740993.5' });
    expect(exact.balanced).toBe(true);
  });

  it('is empty for an empty ledger', () => {
    expect(trialBalance(CHART, [], [])).toEqual({
      rows: [],
      totals: { openingDebit: '0', openingCredit: '0', debit: '0', credit: '0', closingDebit: '0', closingCredit: '0' },
      balanced: true,
    });
  });
});

describe('accountLedger', () => {
  it('runs the balance from the opening balance through each line, with the counter accounts', () => {
    const ledger = accountLedger(CHART, OPENING, LINES, '331');
    expect(ledger.account).toEqual({ code: '331', name: 'Phải trả cho người bán' });
    expect(ledger.opening).toBe('-600000');
    expect(ledger.lines.map((l) => [l.entryId, l.debit, l.credit, l.balance, l.counterAccounts, l.reversal])).toEqual([
      ['e1', '0', '2200000', '-2800000', ['6422', '1331'], false],
      ['e2', '1100000', '0', '-1700000', ['111'], false],
      ['e4', '2200000', '0', '500000', ['6422', '1331'], true],
    ]);
    expect(ledger).toMatchObject({ debit: '3300000', credit: '2200000', closing: '500000' });
  });

  it('includes the lines of sub-accounts, each with its own account', () => {
    const ledger = accountLedger(CHART, OPENING, LINES, '133');
    expect(ledger.opening).toBe('100000');
    expect(ledger.lines.map((l) => [l.accountCode, l.balance, l.counterAccounts])).toEqual([
      ['1331', '300000', ['331']],
      ['1331', '100000', ['331']],
    ]);
    expect(ledger.closing).toBe('100000');
  });

  it('closes on the opening balance for an account with no lines in the period', () => {
    expect(accountLedger(CHART, OPENING, LINES, '411')).toMatchObject({ opening: '-2000000', lines: [], debit: '0', credit: '0', closing: '-2000000' });
    expect(accountLedger(CHART, OPENING, LINES, '1332')).toMatchObject({ opening: '0', lines: [], closing: '0' });
  });

  it('agrees with the trial balance for every account', () => {
    const tb = trialBalance(CHART, OPENING, LINES);
    for (const row of tb.rows.filter((r) => r.accountCode !== '331' && r.accountCode !== '131')) {
      const ledger = accountLedger(CHART, OPENING, LINES, row.accountCode);
      const net = (d: string, c: string) => String(BigInt(d) - BigInt(c));
      expect(ledger.opening, row.accountCode).toBe(net(row.openingDebit, row.openingCredit));
      expect([ledger.debit, ledger.credit], row.accountCode).toEqual([row.debit, row.credit]);
      expect(ledger.closing, row.accountCode).toBe(net(row.closingDebit, row.closingCredit));
    }
  });
});

describe('partyLedger', () => {
  it('lists payables per vendor in the 331 direction, by name', () => {
    const payables = partyLedger(CHART, OPENING, LINES, '331', PARTIES);
    expect(payables.rows).toEqual([
      { partyId: V2, partyName: 'Công ty A', partyTaxCode: '0100000002', opening: '-500000', increase: '0', decrease: '0', closing: '-500000' },
      { partyId: V1, partyName: 'Công ty B', partyTaxCode: '0100000001', opening: '1100000', increase: '2200000', decrease: '3300000', closing: '0' },
    ]);
    expect(payables.totals).toEqual({ opening: '600000', increase: '2200000', decrease: '3300000', closing: '-500000' });
  });

  it('lists receivables per customer in the 131 direction', () => {
    const receivables = partyLedger(CHART, OPENING, LINES, '131', PARTIES);
    expect(receivables.rows).toEqual([
      { partyId: C1, partyName: 'Khách hàng C', partyTaxCode: null, opening: '0', increase: '3300000', decrease: '0', closing: '3300000' },
    ]);
  });

  it('puts lines without a party last and leaves out parties with nothing to show', () => {
    const lines = [line('n', '2026-09-02', '331', '0', '10', null), line('n', '2026-09-02', '111', '10', '0'), line('z', '2026-09-03', '331', '5', '5', V1)];
    const opening: OpeningBalance[] = [{ accountCode: '331', partyId: V2, debit: '7', credit: '7' }];
    const payables = partyLedger(CHART, opening, lines, '331', PARTIES);
    expect(payables.rows.map((r) => [r.partyId, r.partyName, r.closing])).toEqual([
      [V1, 'Công ty B', '0'],
      [null, null, '10'],
    ]);
  });

  it('reads sub-accounts of 331 and an unknown party with no name', () => {
    const chart = [...CHART, { code: '3311', name: 'Phải trả ngắn hạn', parentCode: '331' }];
    const stranger = '00000000-0000-7000-8000-000000000009';
    const payables = partyLedger(chart, [], [line('s', '2026-09-04', '3311', '0', '42', stranger), line('s', '2026-09-04', '111', '42', '0')], '331', PARTIES);
    expect(payables.rows).toEqual([{ partyId: stranger, partyName: null, partyTaxCode: null, opening: '0', increase: '42', decrease: '0', closing: '42' }]);
    // The trial balance splits the sub-account per party too, and rolls it up into 331.
    const tb = trialBalance(chart, [], [line('s', '2026-09-04', '3311', '0', '42', V1), line('s', '2026-09-04', '3311', '40', '0', V2), line('s', '2026-09-04', '111', '2', '0')]);
    expect(tb.rows.filter((r) => r.accountCode.startsWith('331')).map((r) => [r.accountCode, r.closingDebit, r.closingCredit])).toEqual([
      ['331', '40', '42'],
      ['3311', '40', '42'],
    ]);
  });
});
