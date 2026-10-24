// The public booking page's helpers (issue #1318): slots grouped by the visitor's day, times in the visitor's zone, and
// the week one page read covers.
import { describe, expect, it } from 'vitest';
import { dayLabel, slotsByDay, timeIn, weekRange } from '../src/lib/booking.ts';

const slot = (start: string, end: string) => ({ start, end });

describe('booking page helpers', () => {
  it('groups slots by day in the visitor zone, not the host zone', () => {
    // 23:30 UTC on 1 November is 06:30 on 2 November in Vietnam and 00:30 on 2 November in Berlin.
    const slots = [slot('2026-11-02T02:00:00.000Z', '2026-11-02T02:30:00.000Z'), slot('2026-11-01T23:30:00.000Z', '2026-11-02T00:00:00.000Z')];
    expect(slotsByDay(slots, 'Asia/Ho_Chi_Minh').map((d) => [d.date, d.slots.length])).toEqual([['2026-11-02', 2]]);
    // New York: both fall on 1 November (21:00 and 18:30 local).
    expect(slotsByDay(slots, 'America/New_York').map((d) => [d.date, d.slots.length])).toEqual([['2026-11-01', 2]]);
    expect(slotsByDay(slots, 'UTC').map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('shows times on the visitor clock and days by name', () => {
    expect(timeIn('2026-11-02T02:00:00.000Z', 'Asia/Ho_Chi_Minh', 'vi')).toBe('09:00');
    expect(timeIn('2026-11-02T02:00:00.000Z', 'Europe/Berlin', 'en')).toBe('03:00');
    expect(dayLabel('2026-11-02', 'en')).toContain('Monday');
    expect(dayLabel('2026-11-02', 'vi')).toContain('02/11/2026');
  });

  it('reads one week at a time', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    expect(weekRange(now, 0)).toEqual({ from: '2026-10-24T10:00:00.000Z', to: '2026-10-31T10:00:00.000Z' });
    expect(weekRange(now, 2).from).toBe('2026-11-07T10:00:00.000Z');
  });
});
