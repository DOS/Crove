// The answers to the posting definer's source revision refusals (issue #1283, ADR-0021 decision 5): IDEMPOTENCY_CONFLICT,
// REVISION_OUT_OF_ORDER and SOURCE_STILL_POSTED, each a 409 naming the source and revisions, never an amount. The
// definer itself is tested on PostgreSQL in apps/kernel/test/finance-source-revision.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@crove/kernel-runtime';
import { sourceRevisionError } from '../src/ledger.ts';

const SOURCE = { sourceType: 'finance.purchase_document', sourceId: '0190f0a0-0000-7000-8000-000000000001' };
const ENTRY = '0190f0a0-0000-7000-8000-0000000000e1';

describe('source revision refusals', () => {
  it('answers IDEMPOTENCY_CONFLICT for the same revision with another payload', () => {
    const error = sourceRevisionError({
      code: '23505',
      message: 'IDEMPOTENCY_CONFLICT',
      constraint: 'journal_entry_source_revision_key',
      detail: JSON.stringify({ ...SOURCE, revision: 1, entryId: ENTRY }),
    });
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, details: { ...SOURCE, revision: 1, entryId: ENTRY } });
    expect(error?.message).toContain('đã được ghi sổ với nội dung khác');
  });

  it('answers IDEMPOTENCY_CONFLICT for the unique key itself, met by a posting whose snapshot predates the lock', () => {
    expect(sourceRevisionError({ code: '23505', message: 'duplicate key value', constraint: 'journal_entry_source_revision_key' })).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
      details: { sourceType: null, sourceId: null, revision: null, entryId: null },
    });
  });

  it('answers REVISION_OUT_OF_ORDER with the revision expected', () => {
    const error = sourceRevisionError({
      code: '23514',
      message: 'REVISION_OUT_OF_ORDER',
      detail: JSON.stringify({ ...SOURCE, expected: 3, revision: 4 }),
    });
    expect(error).toMatchObject({ code: 'REVISION_OUT_OF_ORDER', status: 409, details: { ...SOURCE, expected: 3, revision: 4 } });
    expect(error?.message).toContain('lần 3');
    expect(error?.message).toContain('không phải lần 4');
  });

  it('answers SOURCE_STILL_POSTED naming the entry to reverse first', () => {
    const error = sourceRevisionError({
      code: '23514',
      message: 'SOURCE_STILL_POSTED',
      detail: JSON.stringify({ ...SOURCE, revision: 1, entryId: ENTRY }),
    });
    expect(error).toMatchObject({ code: 'SOURCE_STILL_POSTED', status: 409, details: { ...SOURCE, revision: 1, entryId: ENTRY } });
    expect(error?.message).toContain('hãy đảo bút toán đó trước');
  });

  it('still answers when the detail is missing or malformed', () => {
    expect(sourceRevisionError({ code: '23514', message: 'SOURCE_STILL_POSTED', detail: 'not json' })).toMatchObject({ code: 'SOURCE_STILL_POSTED' });
    expect(sourceRevisionError({ code: '23514', message: 'REVISION_OUT_OF_ORDER' })?.message).toContain('lần ghi kế tiếp');
  });

  it('leaves every other error alone', () => {
    expect(sourceRevisionError({ code: '23505', message: 'duplicate key value', constraint: 'journal_entry_reverses_uq' })).toBeNull();
    expect(sourceRevisionError({ code: '23514', message: 'journal entry 1 does not balance' })).toBeNull();
    expect(sourceRevisionError({ code: '22023', message: 'AMOUNT_SCALE' })).toBeNull();
    expect(sourceRevisionError(new Error('boom'))).toBeNull();
    expect(sourceRevisionError(null)).toBeNull();
  });
});
