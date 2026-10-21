import { describe, expect, it } from 'vitest';
import { nextMonth, planProgress, reviewUrl } from '../src/lib/social-plan-review.ts';

describe('client review of a content plan (#902)', () => {
  it('suggests from today to the day before the same day next month, across a year end', () => {
    expect(nextMonth(new Date(2026, 9, 21))).toEqual({ from: '2026-10-21', to: '2026-11-20' });
    expect(nextMonth(new Date(2026, 11, 15))).toEqual({ from: '2026-12-15', to: '2027-01-14' });
    expect(nextMonth(new Date(2026, 0, 1))).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('keeps the token after the #', () => {
    expect(reviewUrl('https://crove.example', 'a'.repeat(43))).toBe(`https://crove.example/-/review#${'a'.repeat(43)}`);
  });

  it('counts the posts answered with a verdict, leaving out the gone ones and comments', () => {
    expect(
      planProgress([
        { gone: false, feedback: [{ verdict: 'comment' }] },
        { gone: false, feedback: [{ verdict: 'comment' }, { verdict: 'approved' }] },
        { gone: false, feedback: [{ verdict: 'changes_requested' }] },
        { gone: false },
        { gone: true },
      ]),
    ).toEqual({ total: 4, answered: 2, gone: 1 });
    expect(planProgress([])).toEqual({ total: 0, answered: 0, gone: 0 });
  });
});
