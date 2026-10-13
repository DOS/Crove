import { describe, expect, it } from 'vitest';
import { zLocalDate } from '../src/index.ts';

describe('zLocalDate', () => {
  it('accepts real calendar dates', () => {
    expect(zLocalDate.safeParse('2028-02-29').success).toBe(true);
  });

  it.each(['2026-02-30', '2026-13-01', '0000-00-00', '13/10/2026', '', 'abc'])('rejects %j without throwing', (value) => {
    expect(zLocalDate.safeParse(value).success).toBe(false);
  });
});
