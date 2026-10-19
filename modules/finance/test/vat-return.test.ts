// VAT working per month or quarter (issue #316): rate buckets, periods, the 8% reduced-rate periods, the split of an
// invoice's VAT across its rates (rounding edge cases) and the form 01/GTGT indicators. Amounts are hand-checked.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@crove/l10n-vn';
import { zVatPeriod } from '@crove/kernel-contract';
import {
  documentVatByRate,
  form01Indicators,
  normalizeVatRate,
  reducedRateApplies,
  sideTotals,
  vatPeriod,
  VAT_RATES,
  type DocumentBreakdown,
  type VatLineInput,
} from '../src/index.ts';

const line = (amount: string, vatRate: string | null): VatLineInput => ({ amount, vatRate });
const indicator = (list: ReturnType<typeof form01Indicators>, code: string) => list.find((i) => i.code === code)?.amount;

describe('normalizeVatRate', () => {
  it('reads the rates of Decree 123 e-invoices and common variants', () => {
    expect(normalizeVatRate('10%')).toBe('10');
    expect(normalizeVatRate(' 8 % ')).toBe('8');
    expect(normalizeVatRate('8.0%')).toBe('8');
    expect(normalizeVatRate('05%')).toBe('5');
    expect(normalizeVatRate('0%')).toBe('0');
    expect(normalizeVatRate('10')).toBe('10');
    expect(normalizeVatRate('KCT')).toBe('KCT');
    expect(normalizeVatRate('kkknt')).toBe('KKKNT');
  });

  it('puts anything else in other', () => {
    for (const raw of [null, undefined, '', 'KHAC:3.5%', '7%', '100%', 'mười phần trăm']) expect(normalizeVatRate(raw)).toBe('other');
  });
});

describe('vatPeriod', () => {
  it('turns a month into its first and last day, leap years included', () => {
    expect(vatPeriod('2026-09')).toEqual({ period: '2026-09', kind: 'month', from: '2026-09-01', to: '2026-09-30' });
    expect(vatPeriod('2026-02')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(vatPeriod('2028-02')).toMatchObject({ to: '2028-02-29' });
    expect(vatPeriod('2026-12')).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('turns a quarter into its three months', () => {
    expect(vatPeriod('2026-Q1')).toEqual({ period: '2026-Q1', kind: 'quarter', from: '2026-01-01', to: '2026-03-31' });
    expect(vatPeriod('2026-Q3')).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(vatPeriod('2026-Q4')).toMatchObject({ from: '2026-10-01', to: '2026-12-31' });
  });

  it('refuses anything else', () => {
    for (const bad of ['2026-13', '2026-00', '2026-Q5', '2026-Q0', '26-01', '2026-1', '2026-09-01', '', '1999-01']) {
      expect(() => vatPeriod(bad), bad).toThrow();
    }
  });

  it('keeps the year within 2000 to 2100 at the edge, so the schema refuses it before vatPeriod can throw', () => {
    for (const bad of ['1999-01', '2101-Q1', '0000-01', '9999-12']) expect(zVatPeriod.safeParse(bad).success, bad).toBe(false);
    for (const good of ['2000-01', '2100-Q4', '2026-09']) expect(zVatPeriod.safeParse(good).success, good).toBe(true);
  });
});

describe('reducedRateApplies', () => {
  it('follows the 8% periods, including the 2023 gap and the end of 2026', () => {
    expect(reducedRateApplies('2022-01-31')).toBe(false);
    expect(reducedRateApplies('2022-02-01')).toBe(true);
    expect(reducedRateApplies('2023-03-15')).toBe(false);
    expect(reducedRateApplies('2023-07-01')).toBe(true);
    expect(reducedRateApplies('2025-06-30')).toBe(true);
    expect(reducedRateApplies('2025-07-01')).toBe(true);
    expect(reducedRateApplies('2026-09-15')).toBe(true);
    expect(reducedRateApplies('2026-12-31')).toBe(true);
    expect(reducedRateApplies('2027-01-01')).toBe(false);
  });
});

describe('documentVatByRate', () => {
  it('puts all the VAT of a one-rate invoice on that rate, as invoiced, discounts included', () => {
    // The e-invoice fixture: 1,000,000 + 1,000,000 - 200,000 discount at 10%, VAT 180,000.
    expect(documentVatByRate({ vatAmount: '180000.0000', lines: [line('1000000', '10%'), line('1000000', '10%'), line('-200000', '10%')] })).toEqual({
      rates: [{ rate: '10', taxable: '1800000', vat: '180000' }],
      allocated: false,
    });
    // Per-line rounding on the invoice is kept: 3,333 at 10% invoiced with 333 VAT stays 333.
    expect(documentVatByRate({ vatAmount: '333', lines: [line('3333', '10%')] }).rates).toEqual([{ rate: '10', taxable: '3333', vat: '333' }]);
  });

  it('keeps untaxed rates beside the taxed one with no VAT', () => {
    expect(documentVatByRate({ vatAmount: '50000', lines: [line('1000000', '5%'), line('200000', 'KCT'), line('300000', '0%')] })).toEqual({
      rates: [
        { rate: '0', taxable: '300000', vat: '0' },
        { rate: '5', taxable: '1000000', vat: '50000' },
        { rate: 'KCT', taxable: '200000', vat: '0' },
      ],
      allocated: false,
    });
  });

  it('splits a mixed 8% and 10% invoice by estimate, rounded half up, adding to the invoice VAT exactly', () => {
    // 10% of 1,000,001 = 100,000.1 -> 100,000; 8% of 333,333 = 26,666.64 -> 26,667; together 126,667.
    expect(documentVatByRate({ vatAmount: '126667', lines: [line('1000001', '10%'), line('333333', '8%')] })).toEqual({
      rates: [
        { rate: '8', taxable: '333333', vat: '26667' },
        { rate: '10', taxable: '1000001', vat: '100000' },
      ],
      allocated: true,
    });
    // The invoice rounded per line to one dong more: the difference goes to the largest taxable value (10%).
    expect(documentVatByRate({ vatAmount: '126668', lines: [line('1000001', '10%'), line('333333', '8%')] }).rates).toEqual([
      { rate: '8', taxable: '333333', vat: '26667' },
      { rate: '10', taxable: '1000001', vat: '100001' },
    ]);
  });

  it('rounds a half dong up and gives a tie in taxable value to the higher rate', () => {
    // 5% of 10 = 0.5 -> 1; 10% of 10 = 1; together 2. The invoice says 3: the extra dong goes to 10%.
    expect(documentVatByRate({ vatAmount: '3', lines: [line('10', '5%'), line('10', '10%')] }).rates).toEqual([
      { rate: '5', taxable: '10', vat: '1' },
      { rate: '10', taxable: '10', vat: '2' },
    ]);
  });

  it('puts VAT it cannot place on other, and flags it', () => {
    expect(documentVatByRate({ vatAmount: '100000', lines: [line('1000000', null)] })).toEqual({
      rates: [{ rate: 'other', taxable: '1000000', vat: '100000' }],
      allocated: true,
    });
    expect(documentVatByRate({ vatAmount: '100000', lines: [line('1000000', 'KCT')] })).toEqual({
      rates: [
        { rate: 'KCT', taxable: '1000000', vat: '0' },
        { rate: 'other', taxable: '0', vat: '100000' },
      ],
      allocated: true,
    });
    expect(documentVatByRate({ vatAmount: '0', lines: [line('1000000', null)] })).toEqual({ rates: [{ rate: 'other', taxable: '1000000', vat: '0' }], allocated: false });
  });

  it('handles a negative (adjusting) invoice the same way', () => {
    expect(documentVatByRate({ vatAmount: '-26667', lines: [line('-333333', '8%')] }).rates).toEqual([{ rate: '8', taxable: '-333333', vat: '-26667' }]);
  });

  it('always adds up to the invoice VAT and the line amounts exactly (property)', () => {
    const amount = fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }).map(String);
    const rate = fc.constantFrom('0%', '5%', '8%', '10%', 'KCT', 'KKKNT', 'KHAC:3.5%', null);
    fc.assert(
      fc.property(fc.array(fc.record({ amount, vatRate: rate }), { minLength: 1, maxLength: 12 }), amount, (lines, vatAmount) => {
        const { rates } = documentVatByRate({ vatAmount, lines });
        const vat = rates.reduce((acc, r) => acc.plus(r.vat), new Decimal(0));
        const taxable = rates.reduce((acc, r) => acc.plus(r.taxable), new Decimal(0));
        const lineSum = lines.reduce((acc, l) => acc.plus(l.amount), new Decimal(0));
        return vat.equals(vatAmount) && taxable.equals(lineSum) && rates.every((r) => Number.isInteger(Number(r.vat)));
      }),
    );
  });
});

describe('sideTotals and form01Indicators', () => {
  const sales: DocumentBreakdown[] = [
    { rates: [{ rate: '10', taxable: '1000000', vat: '100000' }], allocated: false },
    { rates: [{ rate: '8', taxable: '500000', vat: '40000' }, { rate: '5', taxable: '200000', vat: '10000' }], allocated: true },
    { rates: [{ rate: '0', taxable: '300000', vat: '0' }, { rate: 'KCT', taxable: '70000', vat: '0' }, { rate: 'KKKNT', taxable: '9000', vat: '0' }], allocated: false },
    { rates: [{ rate: 'other', taxable: '1', vat: '0' }], allocated: false },
  ];
  const purchases: DocumentBreakdown[] = [
    { rates: [{ rate: '10', taxable: '1800000', vat: '180000' }], allocated: false },
    { rates: [{ rate: '8', taxable: '100000', vat: '8000' }, { rate: 'KCT', taxable: '50000', vat: '0' }], allocated: false },
  ];

  it('totals every rate, in order, zero when absent', () => {
    const totals = sideTotals(purchases);
    expect(totals.byRate.map((r) => r.rate)).toEqual([...VAT_RATES]);
    expect(totals.byRate.find((r) => r.rate === '10')).toEqual({ rate: '10', taxable: '1800000', vat: '180000' });
    expect(totals.byRate.find((r) => r.rate === '5')).toEqual({ rate: '5', taxable: '0', vat: '0' });
    expect(totals).toMatchObject({ taxable: '1950000', vat: '188000', documents: 2 });
    expect(sideTotals([])).toMatchObject({ taxable: '0', vat: '0', documents: 0 });
  });

  it('fills the indicators, declaring 8% with 10%', () => {
    const list = form01Indicators(sideTotals(purchases), sideTotals(sales));
    expect(indicator(list, '23')).toBe('1950000');
    expect(indicator(list, '24')).toBe('188000');
    expect(indicator(list, '26')).toBe('70000');
    expect(indicator(list, '29')).toBe('300000');
    expect(indicator(list, '30')).toBe('200000');
    expect(indicator(list, '31')).toBe('10000');
    expect(indicator(list, '32')).toBe('1500000');
    expect(indicator(list, '33')).toBe('140000');
    expect(indicator(list, '32a')).toBe('9000');
    // [27] = [29] + [30] + [32] + [32a]; [28] = [31] + [33]; [34] = [26] + [27]; [35] = [28]. 'other' is in none.
    expect(indicator(list, '27')).toBe('2009000');
    expect(indicator(list, '28')).toBe('150000');
    expect(indicator(list, '34')).toBe('2079000');
    expect(indicator(list, '35')).toBe('150000');
    expect(list.map((i) => i.code)).toEqual(['23', '24', '26', '27', '28', '29', '30', '31', '32', '33', '32a', '34', '35']);
  });

  it('keeps amounts exact beyond what a double holds', () => {
    const big: DocumentBreakdown[] = [
      { rates: [{ rate: '10', taxable: '9007199254740993', vat: '900719925474099' }], allocated: false },
      { rates: [{ rate: '10', taxable: '1', vat: '1' }], allocated: false },
    ];
    expect(indicator(form01Indicators(sideTotals([]), sideTotals(big)), '32')).toBe('9007199254740994');
  });
});
