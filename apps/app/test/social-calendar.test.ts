import { describe, expect, it } from 'vitest';
import { calendarItems, dayId, onDay, startOfWeek, viewDays } from '../src/lib/social-calendar.ts';

type Post = Parameters<typeof calendarItems>[0][number];

const variant = (id: string, status: string, effectiveAt: string | null) => ({ id, status, effectiveAt }) as unknown as Post['variants'][number];
const post = (scheduledAt: string | null, variants: Post['variants']) => ({ id: 'p', scheduledAt, variants }) as unknown as Post;

describe('Social calendar (#580)', () => {
  it('starts weeks on Monday and shows six weeks for a month', () => {
    const wednesday = new Date(2026, 9, 21, 15, 30);
    expect(dayId(startOfWeek(wednesday))).toBe('2026-10-19');
    const month = viewDays('month', new Date(2026, 9, 20));
    expect([month.length, dayId(month[0] as Date), dayId(month.at(-1) as Date)]).toEqual([42, '2026-09-28', '2026-11-08']);
    expect(viewDays('week', wednesday).map(dayId)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  });

  it('keeps the time of day when a channel moves to another day', () => {
    const moved = onDay(new Date(2026, 9, 21, 9, 45), new Date(2026, 9, 24));
    expect([dayId(moved), moved.getHours(), moved.getMinutes()]).toEqual(['2026-10-24', 9, 45]);
  });

  it('places scheduled channels at their time, drafts at the planned time, and leaves out cancelled ones', () => {
    const items = calendarItems([
      post('2026-10-25T02:00:00.000Z', [
        variant('a', 'scheduled', '2026-10-22T02:00:00.000Z'),
        variant('b', 'draft', null),
        variant('c', 'cancelled', '2026-10-23T02:00:00.000Z'),
      ]),
      post(null, [variant('d', 'in_review', null)]),
    ]);
    expect(items.map((i) => [i.v.id, i.at.toISOString(), i.planned])).toEqual([
      ['a', '2026-10-22T02:00:00.000Z', false],
      ['b', '2026-10-25T02:00:00.000Z', true],
    ]);
  });
});