// The approval preview must show exactly the entry the server will post.
import { describe, expect, it } from 'vitest';
import { buildPurchaseJournal } from '../../../packages/l10n-vn/src/index.ts';
import { previewPurchaseJournal, type PreviewLine } from '../src/lib/decimal.ts';

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
