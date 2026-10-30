// Learned account rules (#1399): the normalized text rules match on, and the order a line's account is chosen in.
import { describe, expect, it } from 'vitest';
import {
  bookableLines,
  bookableSaleLines,
  classificationCheck,
  isUnclassifiedLine,
  unclassifiedLineNos,
  UNCLASSIFIED_ACCOUNT,
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

  it('marks a line no rule matches as unclassified, never as 6422 (#2091)', () => {
    const suggestion = suggestDebitAccount(line('Khoản không rõ'), null);
    expect(suggestion).toMatchObject({ account: UNCLASSIFIED_ACCOUNT, rule: { source: 'unclassified' } });
    expect(suggestion.reason).toContain('Chưa phân loại');
    // A line the invoice declares a discount is not a guess: it keeps its built-in 6422.
    expect(suggestDebitAccount({ ...line('Chiết khấu thương mại'), nature: 'discount' }, null)).toMatchObject({ account: '6422', rule: { source: 'builtin' } });
    // A learned rule, the vendor default and a built-in keyword still win over it, unchanged.
    expect(suggestDebitAccount(line('Khoản không rõ'), '156').rule.source).toBe('vendor_default');
    expect(suggestDebitAccount(line('Khoản không rõ'), null, [rule({ id: 'k', kind: 'keyword', text: 'khong ro', account: '5211' })]).rule.source).toBe('learned');
    expect(suggestDebitAccount(line('Phí vận chuyển'), null).rule.source).toBe('builtin');
  });

  it('marks sale lines as proposed by the built-in rule', () => {
    const invoice = {
      lines: [line('Dịch vụ tư vấn')],
    } as unknown as ParsedInvoice;
    expect(bookableSaleLines(invoice)[0]).toMatchObject({ debitAccount: '511', accountRule: { source: 'builtin' } });
  });
});

describe('classification check (#2091)', () => {
  const invoice = (descriptions: string[]) =>
    ({ lines: descriptions.map((d, i) => ({ ...line(d), lineNo: i + 1 })) }) as unknown as ParsedInvoice;

  it('warns with the lines no rule matched and passes when every line has an account', () => {
    const lines = bookableLines(invoice(['Khoản không rõ', 'Phí quảng cáo Google', 'Khoản khác']), null);
    expect(lines.map(isUnclassifiedLine)).toEqual([true, false, true]);
    expect(unclassifiedLineNos(lines)).toEqual([1, 3]);
    expect(classificationCheck(lines)).toMatchObject({ id: 'accounts', status: 'warn', code: 'accounts.unclassified', params: { count: '2', lines: '1, 3' } });
    // A reviewer picked the accounts: the lines are classified (source 'user') and the check passes.
    const picked = lines.map((l) => (isUnclassifiedLine(l) ? { ...l, debitAccount: '6422', accountRule: { source: 'user' as const } } : l));
    expect(unclassifiedLineNos(picked)).toEqual([]);
    expect(classificationCheck(picked)).toMatchObject({ id: 'accounts', status: 'pass', code: 'accounts.classified' });
    expect(classificationCheck([])).toBeNull();
  });

  it('treats the placeholder account as unclassified even without its mark', () => {
    expect(isUnclassifiedLine({ debitAccount: UNCLASSIFIED_ACCOUNT })).toBe(true);
    expect(isUnclassifiedLine({ debitAccount: '6422', accountRule: { source: 'builtin' } })).toBe(false);
  });

  it('names at most 20 lines and keeps the count whole', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ lineNo: i + 1, debitAccount: UNCLASSIFIED_ACCOUNT }));
    const check = classificationCheck(lines);
    expect(check?.params?.count).toBe('30');
    expect((check?.params?.lines ?? '').endsWith(', ...')).toBe(true);
    expect((check?.params?.lines ?? '').length).toBeLessThanOrEqual(200);
  });

  it('leaves a sale untouched: its lines are built-in revenue', () => {
    const lines = bookableSaleLines(invoice(['Khoản lạ']));
    expect(unclassifiedLineNos(lines)).toEqual([]);
  });
});
