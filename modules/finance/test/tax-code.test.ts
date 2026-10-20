// The org's tax code is normalized by the kernel (normalizeTaxCode in @crove/kernel-contract) and compared by finance
// with an invoice seller's code normalized by @crove/l10n-vn parseTaxCode (issue #313). The two must agree on every
// input, or a sale would be read as a purchase. Codes here fail the MST checksum on purpose (synthetic test data).
import { describe, expect, it } from 'vitest';
import { normalizeTaxCode } from '@crove/kernel-contract';
import { parseTaxCode } from '@crove/l10n-vn';
import { journalMemo } from '../src/memo.ts';
import { isOwnTaxCode } from '../src/own-tax-code.ts';

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

describe('the org\'s own tax code (#686)', () => {
  it('is the org\'s code and the codes of its branches, however they are written', () => {
    for (const code of ['0101234564', ' 0101.234.564 ', '0101234564-001', '0101234564001', '0101234564 - 123']) expect(isOwnTaxCode(code, '0101234564'), code).toBe(true);
  });

  it('is not another company, another company\'s branch, or a missing code', () => {
    for (const code of ['0309876546', '0309876546-001', '01012345640', '010123456', '', null]) expect(isOwnTaxCode(code, '0101234564'), String(code)).toBe(false);
    expect(isOwnTaxCode('0101234564', null)).toBe(false);
    expect(isOwnTaxCode('0101234564-001', '')).toBe(false);
  });

  it('gives an org whose own code is a branch only that code, not its head office or the other branches', () => {
    expect(isOwnTaxCode('0101234564-001', '0101234564-001')).toBe(true);
    expect(isOwnTaxCode('0101234564', '0101234564-001')).toBe(false);
    expect(isOwnTaxCode('0101234564-002', '0101234564-001')).toBe(false);
  });

  it('keeps an individual\'s 12-digit code exact', () => {
    expect(isOwnTaxCode('012345678901', '012345678901')).toBe(true);
    expect(isOwnTaxCode('012345678901', '0123456789')).toBe(false);
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
