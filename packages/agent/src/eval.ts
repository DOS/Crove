// Extraction eval scoring (plan §8.7). Compares what the extractor returned with the expected fields of a
// synthetic fixture, field by field, and gates on overall field accuracy. Amounts compare as decimals,
// identifiers through the same normalization the finance module uses, so formatting differences do not count
// as errors. The deterministic invoice checks run on every answer and are reported next to the score.
import { z } from 'zod';
import {
  checkInvoice,
  lineContribution,
  money,
  normalizeNumber,
  normalizeSeries,
  parseTaxCode,
  type InvoiceLine,
  type ParsedInvoice,
} from '@crove/l10n-vn';

const zAmount = z.string().regex(/^-?\d+(\.\d+)?$/, 'plain decimal string');

const zExpectedParty = z.object({ name: z.string(), taxCode: z.string().nullable() });

export const zExpectedInvoice = z.object({
  series: z.string(),
  number: z.string(),
  issueDate: z.iso.date(),
  currency: z.string(),
  seller: zExpectedParty,
  buyer: zExpectedParty,
  lines: z
    .array(
      z.object({
        description: z.string(),
        quantity: zAmount.nullable(),
        unitPrice: zAmount.nullable(),
        amount: zAmount,
        vatRate: z.string().nullable(),
        discount: z.boolean().default(false),
      }),
    )
    .min(1),
  subtotal: zAmount,
  vatTotal: zAmount,
  total: zAmount,
});

export type ExpectedInvoice = z.infer<typeof zExpectedInvoice>;

// One fixture's expected answer: an invoice, or null when the document is not a purchase invoice.
export const zExtractionFixture = z.object({
  description: z.string(),
  expected: zExpectedInvoice.nullable(),
});

export interface FieldResult {
  field: string;
  expected: string | null;
  actual: string | null;
  match: boolean;
}

export interface FixtureScore {
  id: string;
  matched: number;
  total: number;
  fields: FieldResult[];
  // Deterministic checks (checkInvoice) that failed on the extracted invoice.
  failedChecks: string[];
  error: string | null;
}

export interface EvalSummary {
  accuracy: number;
  matched: number;
  total: number;
  threshold: number;
  passed: boolean;
  fixtures: FixtureScore[];
}

const text = (value: string | null | undefined): string => (value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

const taxCode = (value: string | null | undefined): string => parseTaxCode(value)?.normalized ?? text(value).replace(/\s/g, '');

// "10%", "10 %" and "10" are the same rate; "KCT" stays as text.
const rate = (value: string | null | undefined): string => text(value).replace(/[\s%]/g, '');

function sameAmount(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  try {
    return money(expected).equals(money(actual));
  } catch {
    return false;
  }
}

function expectedLine(line: ExpectedInvoice['lines'][number], index: number): InvoiceLine {
  return {
    lineNo: index + 1,
    nature: line.discount ? 'discount' : 'goods',
    code: null,
    description: line.description,
    unit: null,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount: line.amount,
    vatRate: line.vatRate,
  };
}

// The expected answer in the shape the extractor returns, for the deterministic checks.
export function expectedAsParsed(expected: ExpectedInvoice): ParsedInvoice {
  const party = (p: ExpectedInvoice['seller']) => ({ name: p.name, taxCode: p.taxCode, address: null, email: null, phone: null });
  return {
    source: 'ai',
    invoiceType: null,
    template: null,
    series: normalizeSeries(expected.series),
    number: normalizeNumber(expected.number),
    issueDate: expected.issueDate,
    currency: expected.currency,
    exchangeRate: null,
    paymentMethod: null,
    seller: party(expected.seller),
    buyer: party(expected.buyer),
    lines: expected.lines.map(expectedLine),
    taxBreakdown: [],
    subtotal: expected.subtotal,
    vatTotal: expected.vatTotal,
    total: expected.total,
    totalInWords: null,
    taxAuthorityCode: null,
    hasSignature: false,
  };
}

// Scores one answer. `actual` is null when the extractor said "not an invoice", undefined when it failed.
export function scoreExtraction(
  id: string,
  expected: ExpectedInvoice | null,
  actual: ParsedInvoice | null | undefined,
  error: string | null = null,
): FixtureScore {
  const fields: FieldResult[] = [];
  const add = (field: string, exp: string | null, act: string | null, match: boolean) => fields.push({ field, expected: exp, actual: act, match });

  add('isInvoice', String(expected !== null), actual === undefined ? null : String(actual !== null), actual !== undefined && (actual !== null) === (expected !== null));

  if (expected) {
    const got = actual ?? null;
    const str = (field: string, exp: string | null, act: string | null, norm: (v: string | null) => string) =>
      add(field, exp, act, got !== null && norm(exp) === norm(act));
    const amt = (field: string, exp: string | null, act: string | null) => add(field, exp, act, got !== null && sameAmount(exp, act));

    str('series', expected.series, got?.series ?? null, (v) => normalizeSeries(v ?? ''));
    str('number', expected.number, got?.number ?? null, (v) => normalizeNumber(v ?? ''));
    str('issueDate', expected.issueDate, got?.issueDate ?? null, text);
    str('currency', expected.currency, got?.currency ?? null, text);
    str('seller.name', expected.seller.name, got?.seller.name ?? null, text);
    str('seller.taxCode', expected.seller.taxCode, got?.seller.taxCode ?? null, taxCode);
    str('buyer.name', expected.buyer.name, got?.buyer.name ?? null, text);
    str('buyer.taxCode', expected.buyer.taxCode, got?.buyer.taxCode ?? null, taxCode);
    amt('subtotal', expected.subtotal, got?.subtotal ?? null);
    amt('vatTotal', expected.vatTotal, got?.vatTotal ?? null);
    amt('total', expected.total, got?.total ?? null);
    add('lines.count', String(expected.lines.length), got ? String(got.lines.length) : null, got?.lines.length === expected.lines.length);

    // Lines are matched in printed order. A discount may come back signed or unsigned; its signed contribution
    // to the subtotal is what is compared.
    expected.lines.forEach((line, i) => {
      const actualLine = got?.lines[i];
      const prefix = `lines[${i}]`;
      const present = actualLine !== undefined;
      add(`${prefix}.description`, line.description, actualLine?.description ?? null, present && text(line.description) === text(actualLine.description));
      add(`${prefix}.quantity`, line.quantity, actualLine?.quantity ?? null, present && sameAmount(line.quantity, actualLine.quantity));
      add(`${prefix}.unitPrice`, line.unitPrice, actualLine?.unitPrice ?? null, present && sameAmount(line.unitPrice, actualLine.unitPrice));
      add(
        `${prefix}.amount`,
        line.amount,
        actualLine?.amount ?? null,
        present && sameAmount(lineContribution(expectedLine(line, i)), lineContribution(actualLine)),
      );
      add(`${prefix}.vatRate`, line.vatRate, actualLine?.vatRate ?? null, present && rate(line.vatRate) === rate(actualLine.vatRate));
    });
  }

  const failedChecks = actual ? checkInvoice(actual).filter((c) => c.status === 'fail').map((c) => c.id) : [];
  return { id, matched: fields.filter((f) => f.match).length, total: fields.length, fields, failedChecks, error };
}

// Micro-averaged field accuracy over every fixture; the gate fails below `threshold`.
export function summarizeEval(fixtures: FixtureScore[], threshold: number): EvalSummary {
  const matched = fixtures.reduce((n, f) => n + f.matched, 0);
  const total = fixtures.reduce((n, f) => n + f.total, 0);
  const accuracy = total === 0 ? 0 : matched / total;
  return { accuracy, matched, total, threshold, passed: total > 0 && accuracy >= threshold, fixtures };
}

export function formatEvalSummary(summary: EvalSummary): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [`Extraction eval: ${summary.matched}/${summary.total} fields (${pct(summary.accuracy)}), threshold ${pct(summary.threshold)}: ${summary.passed ? 'PASS' : 'FAIL'}`];
  for (const f of summary.fixtures) {
    const extra = [f.error ? `error: ${f.error}` : '', f.failedChecks.length ? `failed checks: ${f.failedChecks.join(', ')}` : ''].filter(Boolean);
    lines.push(`  ${f.id}: ${f.matched}/${f.total}${extra.length ? ` (${extra.join('; ')})` : ''}`);
    for (const miss of f.fields.filter((x) => !x.match)) {
      lines.push(`    ${miss.field}: expected ${JSON.stringify(miss.expected)}, got ${JSON.stringify(miss.actual)}`);
    }
  }
  return lines.join('\n');
}
