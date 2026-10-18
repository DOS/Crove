// The approval preview must show exactly the entry the server will post.
import { describe, expect, it } from 'vitest';
import { buildPurchaseJournal, buildSalesJournal } from '../../../packages/l10n-vn/src/index.ts';
import { isZeroAmount, linesBalance, previewPurchaseJournal, previewSalesJournal, type PreviewLine } from '../src/lib/decimal.ts';

function server(lines: PreviewLine[], vat: string) {
  const proposed = lines.map((l, i) => ({ ...l, lineNo: i + 1, description: '', unit: null, quantity: null, unitPrice: null, reason: '' }));
  return buildPurchaseJournal(proposed, vat, 'memo').map((j) => [j.accountCode, j.debit, j.credit]);
}

function preview(lines: PreviewLine[], vat: string) {
  return previewPurchaseJournal(lines, vat).map((j) => [j.accountCode, j.debit, j.credit]);
}

const CASES: Array<[string, PreviewLine[], string]> = [
  ['goods with a discount', [
    { debitAccount: '6422', amount: '1000000', vatRate: '10%' },
    { debitAccount: '6421', amount: '1000000', vatRate: '10%' },
    { debitAccount: '6422', amount: '-200000', vatRate: '10%' },
  ], '180000'],
  ['adjustment invoice with negative amounts', [{ debitAccount: '6422', amount: '-1000000', vatRate: '10%' }], '-100000'],
  ['fixed asset only', [{ debitAccount: '211', amount: '35000000', vatRate: '10%' }], '3500000'],
  ['fixed asset and supplies', [
    { debitAccount: '211', amount: '35000000', vatRate: '10%' },
    { debitAccount: '153', amount: '1000000', vatRate: '8%' },
  ], '3580000'],
  ['rounding on a mixed invoice', [
    { debitAccount: '211', amount: '33333333', vatRate: '8%' },
    { debitAccount: '6422', amount: '1000001', vatRate: '10%' },
  ], '2766767'],
  // Amounts past the ledger's 4 decimals (the API carries 8): summed exactly per account, rounded once, half up.
  ['fractional amounts summed before rounding', [
    { debitAccount: '6422', amount: '100.00005', vatRate: '10%' },
    { debitAccount: '6422', amount: '100.00005', vatRate: '10%' },
    { debitAccount: '6421', amount: '0.33333333', vatRate: '10%' },
  ], '20.00001'],
  ['half up away from zero on a credit', [{ debitAccount: '6422', amount: '-1000.00005', vatRate: '10%' }], '-100.00005'],
  ['fractional mixed asset invoice', [
    { debitAccount: '211', amount: '33333333.33335', vatRate: '10%' },
    { debitAccount: '6422', amount: '1000.5', vatRate: '8%' },
  ], '3333413.37'],
  ['untaxed asset line', [
    { debitAccount: '211', amount: '40000000', vatRate: 'KCT' },
    { debitAccount: '6422', amount: '500000', vatRate: '10%' },
  ], '50000'],
];

describe('approval preview', () => {
  it.each(CASES)('matches the server entry: %s', (_name, lines, vat) => {
    expect(preview(lines, vat)).toEqual(server(lines, vat));
  });

  it('splits input VAT between fixed assets (1332) and goods (1331)', () => {
    expect(server(CASES[3]?.[1] ?? [], '3580000')).toEqual([
      ['153', '1000000', '0'],
      ['211', '35000000', '0'],
      ['1331', '80000', '0'],
      ['1332', '3500000', '0'],
      ['331', '0', '39580000'],
    ]);
  });
});

// Sales (#313): the line's account is its revenue account; the receivable (131) balances the rounded lines.
function salesServer(lines: PreviewLine[], vat: string) {
  const proposed = lines.map((l, i) => ({ ...l, lineNo: i + 1, description: '', unit: null, quantity: null, unitPrice: null, reason: '' }));
  return buildSalesJournal(proposed, vat, 'memo').map((j) => [j.accountCode, j.debit, j.credit]);
}

const SALES_CASES: Array<[string, PreviewLine[], string]> = [
  ['a sale with a discount', [
    { debitAccount: '511', amount: '1000000', vatRate: '10%' },
    { debitAccount: '511', amount: '1000000', vatRate: '10%' },
    { debitAccount: '511', amount: '-200000', vatRate: '10%' },
  ], '180000'],
  ['revenue sub-accounts', [
    { debitAccount: '5113', amount: '3000000', vatRate: '8%' },
    { debitAccount: '5111', amount: '1000000', vatRate: '10%' },
  ], '340000'],
  ['an adjustment lowering a sale', [{ debitAccount: '511', amount: '-1000000', vatRate: '10%' }], '-100000'],
  ['fractional amounts summed before rounding', [
    { debitAccount: '511', amount: '100.00005', vatRate: '10%' },
    { debitAccount: '511', amount: '100.00005', vatRate: '10%' },
  ], '20.00001'],
  ['no VAT', [{ debitAccount: '511', amount: '500000', vatRate: 'KCT' }], '0'],
];

describe('approval preview of a sale', () => {
  it.each(SALES_CASES)('matches the server entry: %s', (_name, lines, vat) => {
    expect(previewSalesJournal(lines, vat).map((j) => [j.accountCode, j.debit, j.credit])).toEqual(salesServer(lines, vat));
  });
});
describe('zero amounts and balance', () => {
  it('treats every spelling of zero as zero, and nothing else', () => {
    for (const zero of ['0', '0.0000', '0.00', '-0', '-0.0000', '00', '.0', '0.']) expect(isZeroAmount(zero)).toBe(true);
    for (const value of ['1', '0.0001', '-0.5', '10', '100.0000', '', 'abc']) expect(isZeroAmount(value)).toBe(false);
  });

  it('checks that debits and credits add up exactly', () => {
    expect(linesBalance([{ debit: '100.0000', credit: '0' }, { debit: '0', credit: '100' }])).toBe(true);
    expect(linesBalance([{ debit: '100', credit: '0.0000' }, { debit: '0', credit: '99.9999' }])).toBe(false);
  });
});
