// The free-text matcher's TypeScript twins (#1948) against the shared case table; pii-text.db.test.ts runs the same
// cases against the database functions.
import { describe, expect, it } from 'vitest';
import { PII_REDACTED, piiTextMatches, piiTextPattern, piiTextRedact } from '@crove/kernel';
import { PII_TEXT_CASES } from './pii-text-cases.ts';

describe('the free-text matcher in TypeScript (#1948)', () => {
  it.each(PII_TEXT_CASES)('$name', ({ text, value, redacted }) => {
    expect(piiTextRedact(text, value)).toBe(redacted);
    expect(piiTextMatches(text, value)).toBe(redacted !== text);
  });

  it('answers no pattern for what is not a value, and a mark of its own', () => {
    expect(piiTextPattern('Nguyễn Văn A')).toBeNull();
    expect(piiTextPattern('12345')).toBeNull();
    expect(piiTextMatches(null, 'ab@x.com')).toBe(false);
    expect(PII_REDACTED).toBe('[đã xóa]');
  });
});
