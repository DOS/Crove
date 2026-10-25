// Learned account rules (#1399): the normalized text rules match on, and the order a line's account is chosen in.
import { describe, expect, it } from 'vitest';
import {
  bookableSaleLines,
  descriptionRuleText,
  keywordRuleText,
  matchLearnedRule,
  normalizeRuleText,
  RULE_TEXT_MAX,
  suggestDebitAccount,
  type InvoiceLine,
  type LearnedRule,
  type ParsedInvoice,
} from '../src/index.ts';

const line = (description: string, amount = '1000000'): InvoiceLine => ({
  lineNo: 1,
  nature: 'goods',
  code: null,
  description,
  unit: null,
  quantity: null,
  unitPrice: null,
  amount,
  vatRate: '10%',
});

const rule = (over: Partial<LearnedRule> & Pick<LearnedRule, 'id' | 'kind' | 'text' | 'account'>): LearnedRule => ({ vendor: true, label: null, ...over });

describe('rule text', () => {
  it('lowers case, strips Vietnamese marks, reads đ as d and keeps single spaces', () => {
    expect(normalizeRuleText('  Cước Dịch-vụ   INTERNET  (tháng 10/2026) ')).toBe('cuoc dich vu internet thang 10 2026');
    expect(normalizeRuleText('Đồ dùng văn phòng; ĐIỆN, nước')).toBe('do dung van phong dien nuoc');
    // A decomposed string reads the same as a composed one.
    expect(normalizeRuleText('Cước'.normalize('NFD'))).toBe(normalizeRuleText('Cước'.normalize('NFC')));
    // Letters outside the ASCII range that have no base letter are separators.
    expect(normalizeRuleText('服务 phí')).toBe('phi');
  });

  it('drops words with digits from a description, so the month or a number does not make a new item', () => {
    expect(descriptionRuleText('Cước dịch vụ internet tháng 9/2026')).toBe('cuoc dich vu internet thang');
    expect(descriptionRuleText('Cước dịch vụ internet tháng 10/2026')).toBe('cuoc dich vu internet thang');
    expect(descriptionRuleText('Laptop Dell 5420 i7')).toBe('laptop dell');
    // Too little left: no rule.
    expect(descriptionRuleText('12/2026 #3')).toBeNull();
    expect(descriptionRuleText('A 1')).toBeNull();
  });

  it('keeps at most RULE_TEXT_MAX characters, cut at a word', () => {
    const long = descriptionRuleText('dịch vụ '.repeat(60)) ?? '';
    expect(long.length).toBeLessThanOrEqual(RULE_TEXT_MAX);
    expect(long.endsWith(' ')).toBe(false);
    expect(long.split(' ').every((w) => w === 'dich' || w === 'vu')).toBe(true);
    expect(keywordRuleText('x'.repeat(250))).toHaveLength(RULE_TEXT_MAX);
    expect(keywordRuleText(' Chiết khấu ')).toBe('chiet khau');
    expect(keywordRuleText('!')).toBeNull();
  });

  it('matches only text in the shape the database CHECK allows', () => {
    for (const sample of ['Cước dịch vụ', 'Đ-Ơ-N', 'phí   quảng cáo!!', 'x'.repeat(300)]) {
      const text = keywordRuleText(sample);
      expect(text === null || (/^[a-z0-9]+( [a-z0-9]+)*$/.test(text) && text.length >= 2 && text.length <= RULE_TEXT_MAX)).toBe(true);
    }
  });
});

describe('learned rule matching', () => {
  const rules: LearnedRule[] = [
    rule({ id: 'kw-short', kind: 'keyword', text: 'cuoc', account: '6427' }),
    rule({ id: 'kw-long', kind: 'keyword', text: 'cuoc dich vu', account: '6422' }),
    rule({ id: 'desc', kind: 'description', text: 'cuoc dich vu internet thang', account: '242' }),
    rule({ id: 'org-kw', vendor: false, kind: 'keyword', text: 'internet', account: '6423' }),
  ];

  it('prefers the same item, then the longest keyword found as whole words', () => {
    expect(matchLearnedRule('Cước dịch vụ internet tháng 11/2026', rules, true)?.id).toBe('desc');
    expect(matchLearnedRule('Cước dịch vụ truyền hình', rules, true)?.id).toBe('kw-long');
    expect(matchLearnedRule('Cước vận chuyển', rules, true)?.id).toBe('kw-short');
    // Whole words only: "cuocx" is not "cuoc".
    expect(matchLearnedRule('Cuocx abc', rules, true)).toBeNull();
    // Each scope on its own.
    expect(matchLearnedRule('Gói internet', rules, true)).toBeNull();
    expect(matchLearnedRule('Gói internet', rules, false)?.id).toBe('org-kw');
  });

  it('breaks a tie between keywords of the same length by the order given (newest first)', () => {
    const tied = [rule({ id: 'newer', kind: 'keyword', text: 'abc', account: '156' }), rule({ id: 'older', kind: 'keyword', text: 'xyz', account: '152' })];
    expect(matchLearnedRule('xyz abc', tied, true)?.id).toBe('newer');
  });
});

describe('suggestDebitAccount order (#1399)', () => {
  const vendorRule = rule({ id: 'v', kind: 'description', text: 'phi quang cao facebook', account: '6421' });
  const orgRule = rule({ id: 'o', vendor: false, kind: 'keyword', text: 'quang cao', label: 'quảng cáo', account: '6428' });

  it('takes the vendor rule, then the vendor default, then a rule for every vendor, then the built-in keywords', () => {
    expect(suggestDebitAccount(line('Phí quảng cáo Facebook'), '242', [vendorRule, orgRule])).toMatchObject({
      account: '6421',
      rule: { source: 'learned', ruleId: 'v', scope: 'vendor', matchKind: 'description' },
    });
    expect(suggestDebitAccount(line('Phí quảng cáo Google'), '242', [vendorRule, orgRule])).toMatchObject({ account: '242', rule: { source: 'vendor_default' } });
    const shared = suggestDebitAccount(line('Phí quảng cáo Google'), null, [vendorRule, orgRule]);
    expect(shared).toMatchObject({ account: '6428', rule: { source: 'learned', ruleId: 'o', scope: 'org', matchKind: 'keyword' } });
    // The keyword as the member typed it.
    expect(shared.reason).toContain('"quảng cáo"');
    expect(suggestDebitAccount(line('Phí quảng cáo Google'), null, [])).toMatchObject({ account: '6421', rule: { source: 'builtin' } });
    expect(suggestDebitAccount(line('Dịch vụ lạ'), null)).toMatchObject({ account: '6422', rule: { source: 'builtin' } });
  });

  it('marks sale lines as proposed by the built-in rule', () => {
    const invoice = {
      lines: [line('Dịch vụ tư vấn')],
    } as unknown as ParsedInvoice;
    expect(bookableSaleLines(invoice)[0]).toMatchObject({ debitAccount: '511', accountRule: { source: 'builtin' } });
  });
});
