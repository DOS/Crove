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
  // Critical fields that were wrong ("<fixture>: <field>"); any one fails the gate whatever the accuracy.
  criticalMisses: string[];
  passed: boolean;
  fixtures: FixtureScore[];
}

// Never allowed to be wrong, however good the rest is: whether the document is an invoice at all, and the amount
// to pay (the field a planted instruction in a document would target).
export const CRITICAL_FIELDS = ['isInvoice', 'total'] as const;

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

// Quantity and unit price: the extractor is told to write "0" or null when they are not printed, so both count.
const sameOptionalAmount = (expected: string | null, actual: string | null) => sameAmount(expected ?? '0', actual ?? '0');

function sameContribution(expected: InvoiceLine, actual: InvoiceLine): boolean {
  try {
    return money(lineContribution(expected)).equals(money(lineContribution(actual)));
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
      add(`${prefix}.quantity`, line.quantity, actualLine?.quantity ?? null, present && sameOptionalAmount(line.quantity, actualLine.quantity));
      add(`${prefix}.unitPrice`, line.unitPrice, actualLine?.unitPrice ?? null, present && sameOptionalAmount(line.unitPrice, actualLine.unitPrice));
      add(
        `${prefix}.amount`,
        line.amount,
        actualLine?.amount ?? null,
        present && sameContribution(expectedLine(line, i), actualLine),
      );
      add(`${prefix}.vatRate`, line.vatRate, actualLine?.vatRate ?? null, present && rate(line.vatRate) === rate(actualLine.vatRate));
    });
  }

  const failedChecks = actual ? checkInvoice(actual).filter((c) => c.status === 'fail').map((c) => c.id) : [];
  return { id, matched: fields.filter((f) => f.match).length, total: fields.length, fields, failedChecks, error };
}

// Micro-averaged field accuracy over every fixture. The gate fails below `threshold` or on any critical miss.
export function summarizeEval(fixtures: FixtureScore[], threshold: number): EvalSummary {
  const matched = fixtures.reduce((n, f) => n + f.matched, 0);
  const total = fixtures.reduce((n, f) => n + f.total, 0);
  const accuracy = total === 0 ? 0 : matched / total;
  const critical: readonly string[] = CRITICAL_FIELDS;
  const criticalMisses = fixtures.flatMap((f) => f.fields.filter((x) => critical.includes(x.field) && !x.match).map((x) => `${f.id}: ${x.field}`));
  const passed = total > 0 && accuracy >= threshold && criticalMisses.length === 0;
  return { accuracy, matched, total, threshold, criticalMisses, passed, fixtures };
}

export function formatEvalSummary(summary: EvalSummary): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [`Extraction eval: ${summary.matched}/${summary.total} fields (${pct(summary.accuracy)}), threshold ${pct(summary.threshold)}: ${summary.passed ? 'PASS' : 'FAIL'}`];
  if (summary.criticalMisses.length) lines.push(`  critical fields wrong: ${summary.criticalMisses.join(', ')}`);
  for (const f of summary.fixtures) {
    const extra = [f.error ? `error: ${f.error}` : '', f.failedChecks.length ? `failed checks: ${f.failedChecks.join(', ')}` : ''].filter(Boolean);
    lines.push(`  ${f.id}: ${f.matched}/${f.total}${extra.length ? ` (${extra.join('; ')})` : ''}`);
    for (const miss of f.fields.filter((x) => !x.match)) {
      lines.push(`    ${miss.field}: expected ${JSON.stringify(miss.expected)}, got ${JSON.stringify(miss.actual)}`);
    }
  }
  return lines.join('\n');
}

// Document eval (#687): the same scoring over a set of real documents of three kinds, each read through its
// production path (e-invoice XML through the parser, PDF through its text then fromText, photos through
// fromImage). The report gives accuracy per kind and per field and the most frequent errors. The gate is the
// plan's (M2-11): every amount of every XML document exact. PDF and photo accuracy is measured, not gated.
export const DOCUMENT_KINDS = ['xml', 'pdf', 'image'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

// The file extensions the eval reads, with the media type an image is sent as.
const DOCUMENT_EXTENSIONS: Readonly<Record<string, { kind: DocumentKind; mediaType: string }>> = {
  '.xml': { kind: 'xml', mediaType: 'application/xml' },
  '.pdf': { kind: 'pdf', mediaType: 'application/pdf' },
  '.jpg': { kind: 'image', mediaType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mediaType: 'image/jpeg' },
  '.png': { kind: 'image', mediaType: 'image/png' },
  '.webp': { kind: 'image', mediaType: 'image/webp' },
};

export function documentType(filename: string): { kind: DocumentKind; mediaType: string } | null {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? null : (DOCUMENT_EXTENSIONS[filename.slice(dot).toLowerCase()] ?? null);
}

export interface DocumentScore extends FixtureScore {
  kind: DocumentKind;
}

// A field without its line index ("lines[3].amount" -> "lines[].amount"), so lines add up across documents.
export const fieldKey = (field: string): string => field.replace(/^lines\[\d+\]/, 'lines[]');

// The amounts that must be exact on every XML document.
export const XML_AMOUNT_FIELDS: readonly string[] = ['subtotal', 'vatTotal', 'total', 'lines[].amount'];

export interface Rate {
  matched: number;
  total: number;
  accuracy: number;
}

export interface DocumentEvalSummary {
  documents: number;
  byKind: Array<Rate & { kind: DocumentKind; documents: number }>;
  byField: Array<Rate & { field: string }>;
  // The most frequent errors, by kind and field ("extraction" for a document the path failed to read).
  topErrors: Array<{ kind: DocumentKind; field: string; count: number }>;
  // XML amounts that were wrong ("<document>: <field>"); any one fails the gate.
  xmlAmountMisses: string[];
  passed: boolean;
  scores: DocumentScore[];
}

const rateOf = (matched: number, total: number): Rate => ({ matched, total, accuracy: total === 0 ? 0 : matched / total });

export function summarizeDocumentEval(scores: DocumentScore[], topN = 5): DocumentEvalSummary {
  const byKind = DOCUMENT_KINDS.map((kind) => {
    const of = scores.filter((s) => s.kind === kind);
    return { kind, documents: of.length, ...rateOf(of.reduce((n, s) => n + s.matched, 0), of.reduce((n, s) => n + s.total, 0)) };
  }).filter((k) => k.documents > 0);

  // Fields in the order they are first scored, so the table reads like an invoice.
  const fields = new Map<string, { matched: number; total: number }>();
  const errors = new Map<string, { kind: DocumentKind; field: string; count: number }>();
  const miss = (kind: DocumentKind, field: string) => {
    const key = `${kind}\u0000${field}`;
    const entry = errors.get(key) ?? { kind, field, count: 0 };
    entry.count += 1;
    errors.set(key, entry);
  };
  for (const score of scores) {
    if (score.error !== null) miss(score.kind, 'extraction');
    for (const f of score.fields) {
      const key = fieldKey(f.field);
      const entry = fields.get(key) ?? { matched: 0, total: 0 };
      entry.total += 1;
      if (f.match) entry.matched += 1;
      fields.set(key, entry);
      if (!f.match) miss(score.kind, key);
    }
  }
  const topErrors = [...errors.values()]
    .sort((a, b) => b.count - a.count || DOCUMENT_KINDS.indexOf(a.kind) - DOCUMENT_KINDS.indexOf(b.kind) || a.field.localeCompare(b.field))
    .slice(0, topN);
  const xmlAmountMisses = scores
    .filter((s) => s.kind === 'xml')
    .flatMap((s) => s.fields.filter((f) => !f.match && XML_AMOUNT_FIELDS.includes(fieldKey(f.field))).map((f) => `${s.id}: ${f.field}`));
  return {
    documents: scores.length,
    byKind,
    byField: [...fields.entries()].map(([field, r]) => ({ field, ...rateOf(r.matched, r.total) })),
    topErrors,
    xmlAmountMisses,
    passed: scores.length > 0 && xmlAmountMisses.length === 0,
    scores,
  };
}

// The report as Markdown (for a terminal or a GitHub job summary). `showValues` prints what was expected and what
// came back for each wrong field: only for documents that may be published (the committed synthetic set). For the
// private set the report names documents and fields, never their content.
export function formatDocumentEvalReport(summary: DocumentEvalSummary, options: { showValues: boolean }): string {
  const pct = (r: Rate) => `${(r.accuracy * 100).toFixed(1)}% (${r.matched}/${r.total})`;
  const out = [
    `## Document eval: ${summary.passed ? 'PASS' : 'FAIL'}`,
    '',
    `${summary.documents} documents. Gate: every amount of every XML document exact${summary.xmlAmountMisses.length ? `; wrong: ${summary.xmlAmountMisses.join(', ')}` : ''}.`,
    '',
    '| Kind | Documents | Field accuracy |',
    '| --- | --- | --- |',
    ...summary.byKind.map((k) => `| ${k.kind} | ${k.documents} | ${pct(k)} |`),
    '',
    '| Field | Accuracy |',
    '| --- | --- |',
    ...summary.byField.map((f) => `| ${f.field} | ${pct(f)} |`),
    '',
    'Top errors:',
    ...(summary.topErrors.length ? summary.topErrors.map((e) => `- ${e.kind} ${e.field}: ${e.count}`) : ['- none']),
  ];
  const wrong = summary.scores.filter((s) => s.error !== null || s.matched < s.total);
  if (wrong.length) {
    out.push('', 'Per document:');
    for (const s of wrong) {
      out.push(`- ${s.id} (${s.kind}): ${s.matched}/${s.total}${s.error !== null ? (options.showValues ? `, error: ${s.error}` : ', extraction failed') : ''}`);
      for (const f of s.fields.filter((x) => !x.match)) {
        out.push(options.showValues ? `  - ${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}` : `  - ${f.field}`);
      }
    }
  }
  return out.join('\n');
}
