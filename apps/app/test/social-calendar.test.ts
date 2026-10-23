import { describe, expect, it } from 'vitest';
import { calendarItems, dayId, DROP_HOURS, followsPlan, localMoment, notesByDay, onDay, planDrop, plannedAt, startOfWeek, viewDays, type CalendarItem } from '../src/lib/social-calendar.ts';

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
        variant('b', 'draft', '2026-10-25T02:00:00.000Z'),
        variant('c', 'cancelled', '2026-10-23T02:00:00.000Z'),
      ]),
      post(null, [variant('d', 'in_review', null)]),
    ]);
    expect(items.map((i) => [i.v.id, i.at.toISOString(), i.planned])).toEqual([
      ['a', '2026-10-22T02:00:00.000Z', false],
      ['b', '2026-10-25T02:00:00.000Z', true],
    ]);
  });
  it('plans an undated draft at 09:00, or today at the next full hour, and never in the past (#1145)', () => {
    const morning = new Date(2026, 9, 21, 7, 30);
    const afternoon = new Date(2026, 9, 21, 14, 10);
    const late = new Date(2026, 9, 21, 23, 20);
    const at = (d: Date | null) => (d ? [dayId(d), d.getHours(), d.getMinutes()] : null);
    // A later day: 09:00. Today before 09:00: 09:00; after it: the next full hour; after 23:00: nothing left today.
    expect(at(plannedAt(new Date(2026, 9, 24), afternoon))).toEqual(['2026-10-24', 9, 0]);
    expect(at(plannedAt(new Date(2026, 9, 21), morning))).toEqual(['2026-10-21', 9, 0]);
    expect(at(plannedAt(new Date(2026, 9, 21), afternoon))).toEqual(['2026-10-21', 15, 0]);
    expect(plannedAt(new Date(2026, 9, 21), late)).toBeNull();
    expect(plannedAt(new Date(2026, 9, 20), morning)).toBeNull();
    // An hour from the week view: that hour, if it is still ahead.
    expect(at(plannedAt(new Date(2026, 9, 21), afternoon, 18))).toEqual(['2026-10-21', 18, 0]);
    expect(plannedAt(new Date(2026, 9, 21), afternoon, 14)).toBeNull();
    expect(DROP_HOURS[0]).toBe(6);
    expect(DROP_HOURS.at(-1)).toBe(23);
  });

  it('asks social.post.update once per drop, with the revision shown, and refuses a time gone (#1145)', () => {
    const now = new Date(2026, 9, 21, 14, 10);
    const undated = { post: { id: 'p', revision: 3 }, at: null };
    expect(planDrop(undated, new Date(2026, 9, 24), now)).toEqual({ postId: 'p', revision: 3, scheduledAt: new Date(2026, 9, 24, 9, 0).toISOString() });
    expect(planDrop(undated, new Date(2026, 9, 20), now)).toBe('past');
    expect(planDrop(undated, new Date(2026, 9, 24), now, 20)).toEqual({ postId: 'p', revision: 3, scheduledAt: new Date(2026, 9, 24, 20, 0).toISOString() });
    // A planned draft keeps its time of day, or takes the hour dropped on with its minutes; the same time sends nothing.
    const planned = { post: { id: 'q', revision: 7 }, at: new Date(2026, 9, 22, 10, 45) };
    expect(planDrop(planned, new Date(2026, 9, 25), now)).toEqual({ postId: 'q', revision: 7, scheduledAt: new Date(2026, 9, 25, 10, 45).toISOString() });
    expect(planDrop(planned, new Date(2026, 9, 22), now, 16)).toEqual({ postId: 'q', revision: 7, scheduledAt: new Date(2026, 9, 22, 16, 45).toISOString() });
    expect(planDrop(planned, new Date(2026, 9, 22), now)).toBeNull();
    // Today at 10:45 has passed.
    expect(planDrop(planned, new Date(2026, 9, 21), now)).toBe('past');
  });

  it('moves a draft only when it sits at its post’s planned time, and reads the editor’s date and time (#1145)', () => {
    const [follows, own] = calendarItems([
      post('2026-10-25T02:00:00.000Z', [variant('a', 'draft', '2026-10-25T02:00:00.000Z'), variant('b', 'in_review', '2026-10-26T02:00:00.000Z')]),
    ]);
    expect([followsPlan(follows as CalendarItem), followsPlan(own as CalendarItem)]).toEqual([true, false]);
    const [scheduled] = calendarItems([post('2026-10-25T02:00:00.000Z', [variant('c', 'scheduled', '2026-10-25T02:00:00.000Z')])]);
    expect(followsPlan(scheduled as CalendarItem)).toBe(false);
    const moment = localMoment('2026-10-24', '08:30');
    expect(moment && [dayId(moment), moment.getHours(), moment.getMinutes()]).toEqual(['2026-10-24', 8, 30]);
    expect([localMoment('', '08:30'), localMoment('2026-10-24', '')]).toEqual([null, null]);
  });

it('puts a note on every day it covers, both ends included (#794)', () => {
    const days = viewDays('week', new Date(2026, 9, 21));
    const byDay = notesByDay([{ id: 'sale', startsOn: '2026-10-20', endsOn: '2026-10-22' }, { id: 'later', startsOn: '2026-11-01', endsOn: '2026-11-01' }], days);
    expect([...byDay.keys()]).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(byDay.get('2026-10-21')?.map((n) => n.id)).toEqual(['sale']);
  });
});