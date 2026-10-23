import { describe, expect, it } from 'vitest';
import { MAX_BULK_APPROVE, SOCIAL_REVIEW_CHECK_LABEL_MAX, contract, zBulkApproveItems, zLocalDate, zSocialReviewChecklistSet, zSocialSuggestion } from '../src/index.ts';

describe('zBulkApproveItems (#315)', () => {
  const item = (n: number) => ({ id: `0190a3c4-0000-7000-8000-${String(n).padStart(12, '0')}`, revision: 1 });
  const key = '0190a3c4-0000-7000-8000-999999999999';

  it('takes 1 to 50 proposals, each once', () => {
    expect(zBulkApproveItems.safeParse([item(1), item(2)]).success).toBe(true);
    expect(zBulkApproveItems.safeParse(Array.from({ length: MAX_BULK_APPROVE }, (_, i) => item(i))).success).toBe(true);
    expect(zBulkApproveItems.safeParse([]).success).toBe(false);
    expect(zBulkApproveItems.safeParse(Array.from({ length: MAX_BULK_APPROVE + 1 }, (_, i) => item(i))).success).toBe(false);
    expect(zBulkApproveItems.safeParse([item(1), { ...item(1), revision: 2 }]).success).toBe(false);
  });

  it('is the input of the inbox.approveMany route, so a repeated proposal is refused at the edge', () => {
    const input = contract.inbox.approveMany['~orpc'].inputSchema;
    expect(input?.['~standard'].validate({ items: [item(1), item(1)], idempotencyKey: key })).toHaveProperty('issues');
    expect(input?.['~standard'].validate({ items: [item(1), item(2)], idempotencyKey: key })).not.toHaveProperty('issues');
  });
});

describe('zLocalDate', () => {
  it('accepts real calendar dates', () => {
    expect(zLocalDate.safeParse('2028-02-29').success).toBe(true);
    // 0001-01-01 is PostgreSQL's lower bound for date input and stays valid; the upper bound is 9999-12-31.
    for (const value of ['0001-01-01', '0001-12-31', '1900-01-01', '9999-12-31']) expect(zLocalDate.safeParse(value).success).toBe(true);
  });

  it.each(['2026-02-30', '2026-13-01', '0000-00-00', '0000-01-01', '0000-12-31', '13/10/2026', '', 'abc'])('rejects %j without throwing', (value) => {
    expect(zLocalDate.safeParse(value).success).toBe(false);
  });
});

describe('zSocialReviewChecklistSet (#1113)', () => {
  const one = (label: string) => zSocialReviewChecklistSet.safeParse({ items: [{ connectionId: null, label }] });

  it('counts a label in code points after NFC and white space collapse, as the module and the database do', () => {
    // 120 emoji are 240 UTF-16 units: taken, as the database's length() counts 120.
    expect(one('🎉'.repeat(SOCIAL_REVIEW_CHECK_LABEL_MAX)).success).toBe(true);
    expect(one('🎉'.repeat(SOCIAL_REVIEW_CHECK_LABEL_MAX + 1)).success).toBe(false);
    // Longer as typed, 120 once its spaces are collapsed.
    const spaced = `  ${'a '.repeat(SOCIAL_REVIEW_CHECK_LABEL_MAX / 2 - 1)}ab   `;
    expect(spaced.length).toBeGreaterThan(SOCIAL_REVIEW_CHECK_LABEL_MAX);
    expect(one(spaced).data?.items[0]?.label).toBe(`${'a '.repeat(SOCIAL_REVIEW_CHECK_LABEL_MAX / 2 - 1)}ab`);
    // Decomposed Vietnamese is stored composed.
    expect(one('Kiểm tra'.normalize('NFD')).data?.items[0]?.label).toBe('Kiểm tra'.normalize('NFC'));
    expect(one('   ').success).toBe(false);
  });
});

describe('zSocialSuggestion (#1236)', () => {
  it('takes a range that holds its quote and a change of it', () => {
    expect(zSocialSuggestion.safeParse({ field: 'post', start: 3, end: 6, quote: 'hai', text: 'ba' }).success).toBe(true);
    expect(zSocialSuggestion.safeParse({ field: 'channel', start: 0, end: 2, quote: '🎉', text: '' }).success).toBe(true);
    expect(zSocialSuggestion.safeParse({ field: 'post', start: 3, end: 5, quote: 'hai', text: 'ba' }).success).toBe(false);
    expect(zSocialSuggestion.safeParse({ field: 'post', start: 3, end: 3, quote: '', text: 'ba' }).success).toBe(false);
    expect(zSocialSuggestion.safeParse({ field: 'post', start: 3, end: 6, quote: 'hai', text: 'hai' }).success).toBe(false);
    expect(zSocialSuggestion.safeParse({ field: 'title', start: 3, end: 6, quote: 'hai', text: 'ba' }).success).toBe(false);
  });
});