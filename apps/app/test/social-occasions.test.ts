import { describe, expect, it } from 'vitest';
import { occasionStart, OCCASION_IDS } from '../src/lib/social-occasions.ts';

describe('occasion posts (#702)', () => {
  it('plans a post three days before at 09:00, or the next hour when that has gone by', () => {
    const now = new Date(2026, 9, 10, 14, 30);
    expect(occasionStart('2026-10-20', now)).toEqual(new Date(2026, 9, 17, 9, 0));
    expect(occasionStart('2026-10-12', now)).toEqual(new Date(2026, 9, 10, 15, 0));
    expect(occasionStart('2026-10-10', now)).toEqual(new Date(2026, 9, 10, 15, 0));
    expect(occasionStart('2026-10-09', now)).toBeNull();
    // Late on the day itself: no hour of it is left.
    expect(occasionStart('2026-10-10', new Date(2026, 9, 10, 23, 30))).toBeNull();
    expect(occasionStart('khong', now)).toBeNull();
  });

  it('knows the occasion ids the composer accepts', () => {
    expect(OCCASION_IDS.has('tet')).toBe(true);
    expect(OCCASION_IDS.has('mid_autumn')).toBe(true);
    expect(OCCASION_IDS.has('<script>')).toBe(false);
  });
});
