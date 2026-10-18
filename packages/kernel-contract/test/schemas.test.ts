import { describe, expect, it } from 'vitest';
import { MAX_BULK_APPROVE, contract, zBulkApproveItems, zLocalDate } from '../src/index.ts';

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
  });

  it.each(['2026-02-30', '2026-13-01', '0000-00-00', '13/10/2026', '', 'abc'])('rejects %j without throwing', (value) => {
    expect(zLocalDate.safeParse(value).success).toBe(false);
  });
});
