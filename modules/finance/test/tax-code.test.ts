// The org's tax code is normalized by the kernel (normalizeTaxCode in @crove/kernel-contract) and compared by finance
// with an invoice seller's code normalized by @crove/l10n-vn parseTaxCode (issue #313). The two must agree on every
// input, or a sale would be read as a purchase. Codes here fail the MST checksum on purpose (synthetic test data).
import { describe, expect, it } from 'vitest';
import { normalizeTaxCode } from '@crove/kernel-contract';
import { parseTaxCode } from '@crove/l10n-vn';
import { journalMemo } from '../src/memo.ts';

describe('the org tax code and the invoice seller tax code', () => {
  it('normalize every input the same way', () => {
    const inputs = [
      '0101234564',
      ' 0101 234 564 ',
      '0101.234.564',
      '0101234564-001',
      '0101234564001',
      '0101234564 - 001',
      '012345678901',
      '01012345',
      '01012345640',
      '0101234564-01',
      'MST0101234564',
      '',
      '   ',
      null,
    ];
    for (const input of inputs) expect(normalizeTaxCode(input), String(input)).toBe(parseTaxCode(input)?.normalized ?? null);
  });
});

describe('journal memo', () => {
  const ref = (name: string) => ({ name, taxCode: null, address: null, email: null, phone: null });
  it('names the supplier of a purchase and the customer of a sale', () => {
    const invoice = { series: 'C26TAB', number: '12' };
    expect(journalMemo({ seller: ref('NCC A'), buyer: ref('Org'), invoice })).toBe('HĐ C26TAB-12 NCC A');
    expect(journalMemo({ direction: 'sale', seller: ref('Org'), buyer: ref('Khách B'), invoice })).toBe('HĐ bán C26TAB-12 Khách B');
    expect(journalMemo({ direction: 'sale', seller: ref('Org'), buyer: ref(''), invoice: { series: '', number: '7' } })).toBe('HĐ bán 7');
  });
});
