import { describe, expect, it } from 'vitest';
import { checkInvoice, parseTaxCode } from '@crove/l10n-vn';
import {
  documentType,
  expectedAsParsed,
  fieldKey,
  formatDocumentEvalReport,
  formatEvalSummary,
  scoreExtraction,
  summarizeDocumentEval,
  summarizeEval,
  type DocumentKind,
  type ExpectedInvoice,
} from '../src/index.ts';
import { loadExtractionFixtures } from './support.ts';

const expected: ExpectedInvoice = {
  series: 'C26TAA',
  number: '00000123',
  issueDate: '2026-09-15',
  currency: 'VND',
  seller: { name: 'CÔNG TY TNHH MẪU THỬ', taxCode: '9900123450' },
  buyer: { name: 'Khách lẻ', taxCode: null },
  lines: [
    { description: 'Dịch vụ', quantity: '2', unitPrice: '500000', amount: '1000000', vatRate: '10%', discount: false },
    { description: 'Chiết khấu', quantity: null, unitPrice: null, amount: '100000', vatRate: '10%', discount: true },
  ],
  subtotal: '900000',
  vatTotal: '90000',
  total: '990000',
};

// 1 isInvoice + 11 header fields + 1 line count + 5 per line.
const FIELDS = 1 + 11 + 1 + 5 * expected.lines.length;

describe('extraction scoring', () => {
  it('scores a perfect answer 100% regardless of formatting', () => {
    const actual = expectedAsParsed(expected);
    actual.number = '123';
    actual.seller.name = '  công ty tnhh   mẫu thử ';
    actual.subtotal = '900000.00';
    actual.lines[0]!.vatRate = '10';
    actual.lines[1]!.amount = '-100000';
    const score = scoreExtraction('perfect', expected, actual);
    expect(score.total).toBe(FIELDS);
    expect(score.fields.filter((f) => !f.match)).toEqual([]);
    expect(score.failedChecks).toEqual([]);
  });

  it('counts each wrong field and reports the deterministic checks that fail', () => {
    const actual = expectedAsParsed(expected);
    actual.total = '9900000';
    actual.seller.taxCode = '9900123451';
    const score = scoreExtraction('wrong', expected, actual);
    expect(score.matched).toBe(FIELDS - 2);
    expect(score.fields.filter((f) => !f.match).map((f) => f.field)).toEqual(['seller.taxCode', 'total']);
    expect(score.failedChecks).toEqual(['total']);
  });

  it('scores a missing line as wrong in every line field', () => {
    const actual = expectedAsParsed(expected);
    actual.lines = actual.lines.slice(0, 1);
    const score = scoreExtraction('short', expected, actual);
    expect(score.fields.filter((f) => !f.match).map((f) => f.field)).toEqual([
      'lines.count',
      'lines[1].description',
      'lines[1].quantity',
      'lines[1].unitPrice',
      'lines[1].amount',
      'lines[1].vatRate',
    ]);
  });

  it('scores "not an invoice" on the single isInvoice field', () => {
    expect(scoreExtraction('quote', null, null)).toMatchObject({ matched: 1, total: 1 });
    expect(scoreExtraction('quote', null, expectedAsParsed(expected))).toMatchObject({ matched: 0, total: 1 });
    expect(scoreExtraction('missed', expected, null)).toMatchObject({ matched: 0, total: FIELDS });
  });

  it('scores a failed extraction as zero and keeps the error', () => {
    const score = scoreExtraction('failed', expected, undefined, 'AmountFormatError');
    expect(score).toMatchObject({ matched: 0, total: FIELDS, error: 'AmountFormatError', failedChecks: [] });
  });

  it('treats an unprinted quantity or unit price as null or "0"', () => {
    const actual = expectedAsParsed(expected);
    actual.lines[1]!.quantity = '0';
    actual.lines[1]!.unitPrice = '0';
    expect(scoreExtraction('zeros', expected, actual).fields.filter((f) => !f.match)).toEqual([]);
  });

  it('gates on micro-averaged field accuracy', () => {
    const good = scoreExtraction('good', expected, expectedAsParsed(expected));
    const other = expectedAsParsed(expected);
    other.buyer.name = 'Someone else';
    const summary = summarizeEval([good, scoreExtraction('other', expected, other)], 0.9);
    expect(summary.accuracy).toBeCloseTo((2 * FIELDS - 1) / (2 * FIELDS));
    expect(summary.passed).toBe(true);
    expect(summarizeEval([good], 1.01).passed).toBe(false);
    expect(summarizeEval([], 0).passed).toBe(false);
    expect(formatEvalSummary(summary)).toContain(`other: ${FIELDS - 1}/${FIELDS}`);
  });

  it('fails on a wrong critical field even when accuracy is high', () => {
    const good = scoreExtraction('good', expected, expectedAsParsed(expected));
    // A quotation read as an invoice, and an invoice whose total followed a planted instruction.
    const quote = scoreExtraction('quote', null, expectedAsParsed(expected));
    const injected = expectedAsParsed(expected);
    injected.total = '0';
    const summary = summarizeEval([good, good, good, quote, scoreExtraction('injected', expected, injected)], 0.5);
    expect(summary.accuracy).toBeGreaterThan(0.9);
    expect(summary.criticalMisses).toEqual(['quote: isInvoice', 'injected: total']);
    expect(summary.passed).toBe(false);
    expect(formatEvalSummary(summary)).toContain('critical fields wrong: quote: isInvoice, injected: total');
  });
});

describe('document eval summary (#687)', () => {
  const doc = (id: string, kind: DocumentKind, edit: (a: ReturnType<typeof expectedAsParsed>) => void = () => {}) => {
    const actual = expectedAsParsed(expected);
    edit(actual);
    return { kind, ...scoreExtraction(id, expected, actual) };
  };

  it('knows the kinds by extension', () => {
    expect(documentType('a/HD-01.XML')).toEqual({ kind: 'xml', mediaType: 'application/xml' });
    expect(documentType('b.pdf')?.kind).toBe('pdf');
    expect(documentType('c.JPEG')).toEqual({ kind: 'image', mediaType: 'image/jpeg' });
    expect(documentType('d.webp')?.mediaType).toBe('image/webp');
    expect(documentType('e.json')).toBeNull();
    expect(documentType('noext')).toBeNull();
    expect(fieldKey('lines[12].amount')).toBe('lines[].amount');
    expect(fieldKey('seller.taxCode')).toBe('seller.taxCode');
  });

  it('reports accuracy per kind and per field, and the most frequent errors', () => {
    const summary = summarizeDocumentEval([
      doc('x1', 'xml'),
      doc('p1', 'pdf', (a) => {
        a.seller.taxCode = '0000000000';
        a.lines[1]!.vatRate = '8%';
      }),
      doc('p2', 'pdf', (a) => {
        a.seller.taxCode = null;
      }),
      { kind: 'image' as const, ...scoreExtraction('i1', expected, undefined, 'AmountFormatError: x') },
    ]);
    expect(summary.byKind.map((k) => [k.kind, k.documents, k.matched, k.total])).toEqual([
      ['xml', 1, FIELDS, FIELDS],
      ['pdf', 2, 2 * FIELDS - 3, 2 * FIELDS],
      ['image', 1, 0, FIELDS],
    ]);
    expect(summary.byField.find((f) => f.field === 'seller.taxCode')).toMatchObject({ matched: 1, total: 4 });
    expect(summary.byField.find((f) => f.field === 'lines[].vatRate')).toMatchObject({ matched: 5, total: 8 });
    expect(summary.topErrors[0]).toEqual({ kind: 'pdf', field: 'seller.taxCode', count: 2 });
    expect(summary.topErrors).toHaveLength(5);
    expect(summary.topErrors.map((e) => e.kind)).toContain('image');
    // PDF and photo errors are measured, not gated.
    expect(summary).toMatchObject({ passed: true, xmlAmountMisses: [] });
  });

  it('fails on any wrong XML amount, a line amount too', () => {
    const summary = summarizeDocumentEval([
      doc('x1', 'xml', (a) => {
        a.lines[0]!.amount = '1000001';
      }),
      doc('x2', 'xml', (a) => {
        a.vatTotal = '90001';
      }),
      doc('p1', 'pdf', (a) => {
        a.total = '1';
      }),
    ]);
    expect(summary.xmlAmountMisses).toEqual(['x1: lines[0].amount', 'x2: vatTotal']);
    expect(summary.passed).toBe(false);
    expect(summarizeDocumentEval([]).passed).toBe(false);
  });

  it('prints wrong values only when asked, so a private document never reaches a log', () => {
    const summary = summarizeDocumentEval([
      doc('private/hd-01', 'pdf', (a) => {
        a.seller.name = 'Công ty thật';
      }),
      { kind: 'image' as const, ...scoreExtraction('private/hd-02', expected, undefined, 'AmountFormatError: 1.250.000') },
    ]);
    const hidden = formatDocumentEvalReport(summary, { showValues: false });
    expect(hidden).toContain('- private/hd-01 (pdf):');
    expect(hidden).toContain('  - seller.name');
    expect(hidden).toContain('extraction failed');
    expect(hidden).not.toContain('Công ty thật');
    expect(hidden).not.toContain('MẪU THỬ');
    expect(hidden).not.toContain('1.250.000');
    const shown = formatDocumentEvalReport(summary, { showValues: true });
    expect(shown).toContain('expected "CÔNG TY TNHH MẪU THỬ", got "Công ty thật"');
    expect(shown).toContain('error: AmountFormatError: 1.250.000');
    expect(shown).toContain('| pdf | 1 |');
  });
});

describe('synthetic extraction fixtures', () => {
  const fixtures = loadExtractionFixtures();

  it('has invoices and at least one document that is not an invoice', () => {
    expect(fixtures.filter((f) => f.expected).length).toBeGreaterThanOrEqual(3);
    expect(fixtures.some((f) => f.expected === null)).toBe(true);
  });

  // Plan §8.7: fixtures are synthetic. A checksum-valid tax code could belong to a real business, and a
  // 12-digit run could be a real national ID, so neither may appear.
  it.each(fixtures.map((f) => [f.id, f] as const))('%s uses only checksum-invalid tax codes', (_id, fixture) => {
    const texts = [fixture.text, JSON.stringify(fixture.expected)];
    for (const text of texts) {
      expect(text).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
      for (const run of text.match(/(?<!\d)\d{10}(-\d{3})?(?!\d)/g) ?? []) {
        expect(parseTaxCode(run)?.checksumValid, run).toBe(false);
      }
    }
  });

  it.each(fixtures.filter((f) => f.expected).map((f) => [f.id, f] as const))('%s passes the deterministic checks itself', (_id, fixture) => {
    const failed = checkInvoice(expectedAsParsed(fixture.expected!))
      .filter((c) => c.status === 'fail' && c.id !== 'currency')
      .map((c) => c.id);
    expect(failed).toEqual([]);
    for (const party of [fixture.expected!.seller, fixture.expected!.buyer]) {
      if (party.taxCode) expect(fixture.text).toContain(party.taxCode);
    }
  });
});
