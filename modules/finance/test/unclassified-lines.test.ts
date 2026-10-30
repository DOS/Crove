// SPDX-License-Identifier: AGPL-3.0-only
// Invoice lines no account rule matched (#2091): extraction proposes them as unclassified with a warning check, a line
// a rule matches is proposed as before, and the placeholder the kernel counts them by is the one l10n-vn writes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNCLASSIFIED_ACCOUNT_CODE, zPurchaseProposal, type PurchaseProposal } from '@crove/kernel-contract';
import type { ExtractClient } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { UNCLASSIFIED_ACCOUNT, type LearnedRule, type ParsedInvoice } from '@crove/l10n-vn';
import { extractAndPropose } from '../src/extract.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-000000000002';
const BYTES = new TextEncoder().encode('%PDF');
const SHA256 = sha256Hex(BYTES);
const parsed = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;

// An invoice read from a PDF by AI whose lines are `descriptions`, each worth 1,000,000 before 10% VAT.
function invoiceOf(descriptions: string[], natures: Record<number, 'discount'> = {}): ParsedInvoice {
  const copy = structuredClone(parsed);
  copy.source = 'ai';
  copy.lines = descriptions.map((description, i) => ({ ...parsed.lines[0]!, lineNo: i + 1, nature: natures[i + 1] ?? parsed.lines[0]!.nature, description, amount: '1000000', vatRate: '10%', quantity: null, unitPrice: null }));
  const subtotal = descriptions.length * 1000000;
  copy.subtotal = String(subtotal);
  copy.vatTotal = String(subtotal / 10);
  copy.total = String(subtotal + subtotal / 10);
  copy.taxBreakdown = [{ rate: '10%', taxableAmount: String(subtotal), vatAmount: String(subtotal / 10) }];
  return copy;
}

async function propose(
  descriptions: string[],
  lookup: { vendorDefault?: string | null; learnedRules?: LearnedRule[] } = {},
  natures: Record<number, 'discount'> = {},
): Promise<PurchaseProposal> {
  const seen: { payload: PurchaseProposal | undefined } = { payload: undefined };
  const runtime = {
    query: async (name: string) =>
      name === 'finance.extraction.file'
        ? { id: FILE, filename: 'hd.pdf', content_type: 'application/pdf', storage_key: `org/${ORG}/${SHA256}`, generation: `content:${SHA256}`, sha256: SHA256, hasExtraction: false, due: true }
        : { vendorDefault: null, duplicateDocumentId: null, duplicateProposalId: null, ...lookup },
    execute: async (_name: string, input: unknown) => {
      seen.payload = (input as { proposal: { payload: PurchaseProposal } | null }).proposal?.payload;
      return { proposalId: null };
    },
  } as unknown as Runtime;
  const store = { get: async () => BYTES } as unknown as BlobStore;
  const extract: ExtractClient = { extract: async () => ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 }) as never };
  const extractor = { fromText: async () => invoiceOf(descriptions, natures), fromImage: async () => null };
  await extractAndPropose({ runtime, store, extractor: extractor as never, extract, today: () => '2026-10-13' }, ORG, FILE);
  const payload = seen.payload;
  if (!payload) throw new Error('no proposal was recorded')
  expect(zPurchaseProposal.safeParse(payload).success).toBe(true);
  return payload;
}

describe('unclassified invoice lines (#2091)', () => {
  it('writes the placeholder the kernel counts unclassified lines by', () => {
    expect(UNCLASSIFIED_ACCOUNT).toBe(UNCLASSIFIED_ACCOUNT_CODE);
  });

  it('proposes a line no rule matched as unclassified, with a warning that names it and no 6422 guess', async () => {
    const payload = await propose(['Phí quảng cáo Google', 'Khoản không rõ', 'Khoản khác']);
    expect(payload.lines.map((l) => [l.lineNo, l.debitAccount, l.accountRule?.source])).toEqual([
      [1, '6421', 'builtin'],
      [2, UNCLASSIFIED_ACCOUNT_CODE, 'unclassified'],
      [3, UNCLASSIFIED_ACCOUNT_CODE, 'unclassified'],
    ]);
    expect(payload.lines.some((l) => l.debitAccount === '6422')).toBe(false);
    expect(payload.checks.find((c) => c.id === 'accounts')).toMatchObject({
      status: 'warn',
      code: 'accounts.unclassified',
      params: { count: '2', lines: '2, 3' },
    });
    // The journal draft is still balanced; the placeholder stands in until a reviewer picks the accounts.
    expect(payload.journal.some((j) => j.accountCode === UNCLASSIFIED_ACCOUNT_CODE)).toBe(true);
  });

  it('leaves lines a rule matches unchanged and adds no check', async () => {
    const payload = await propose(['Phí quảng cáo Google', 'Cước internet']);
    expect(payload.lines.map((l) => [l.debitAccount, l.accountRule?.source])).toEqual([
      ['6421', 'builtin'],
      ['6422', 'builtin'],
    ]);
    expect(payload.checks.some((c) => c.id === 'accounts')).toBe(false);
  });

  // The e-invoice fixture's line 3 ("Chiết khấu thương mại", TChat 3) keeps its built-in 6422, covered by the db test that
  // approves the fixture and by the l10n-vn test of bookableLines. A model reading a photo or PDF can set a line's
  // nature, so there the same words stay unclassified: no injected "discount" can skip the review.
  it('does not trust a discount nature a model read from a PDF', async () => {
    const payload = await propose(['Phí quảng cáo Google', 'Chiết khấu thương mại'], {}, { 2: 'discount' });
    expect(payload.lines[1]).toMatchObject({ debitAccount: UNCLASSIFIED_ACCOUNT_CODE, accountRule: { source: 'unclassified' } });
    expect(payload.checks.find((c) => c.id === 'accounts')).toMatchObject({ status: 'warn', params: { lines: '2' } });
  });

  it('keeps learned rules and the vendor default working: they classify the line', async () => {
    const learned: LearnedRule = { id: '00000000-0000-4000-8000-0000000000a1', vendor: true, kind: 'keyword', text: 'khoan khong ro', label: null, account: '6428' };
    const withRule = await propose(['Khoản không rõ'], { learnedRules: [learned] });
    expect(withRule.lines[0]).toMatchObject({ debitAccount: '6428', accountRule: { source: 'learned', ruleId: '00000000-0000-4000-8000-0000000000a1' } });
    expect(withRule.checks.some((c) => c.id === 'accounts')).toBe(false);
    const withDefault = await propose(['Khoản không rõ'], { vendorDefault: '156' });
    expect(withDefault.lines[0]).toMatchObject({ debitAccount: '156', accountRule: { source: 'vendor_default' } });
    expect(withDefault.checks.some((c) => c.id === 'accounts')).toBe(false);
  });
});
