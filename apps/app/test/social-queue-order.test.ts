// Reordering a queue from the app (#1020): the date range a shuffle takes, and the channels that can go first.
import { describe, expect, it } from 'vitest';
import { canMoveToFront, shuffleRange } from '../src/lib/social-queue-order.ts';

describe('shuffleRange', () => {
  it('takes whole local days in the queue time zone, both ends included', () => {
    // Ho Chi Minh City is UTC+7: 20 October starts at 17:00 UTC the day before.
    expect(shuffleRange('2026-10-20', '2026-10-22', 'Asia/Ho_Chi_Minh')).toEqual({ from: '2026-10-19T17:00:00.000Z', to: '2026-10-22T16:59:59.999Z' });
    expect(shuffleRange('2026-10-20', '2026-10-20', 'Asia/Ho_Chi_Minh')).toEqual({ from: '2026-10-19T17:00:00.000Z', to: '2026-10-20T16:59:59.999Z' });
  });

  it('keeps a day whole across a clock change', () => {
    // New York leaves daylight saving time on 1 November 2026: that day lasts 25 hours.
    const r = shuffleRange('2026-11-01', '2026-11-01', 'America/New_York');
    expect(r).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T04:59:59.999Z' });
  });

  it('leaves an empty end open, and refuses a range that ends first or a date that is not one', () => {
    expect(shuffleRange('', '', 'UTC')).toEqual({});
    expect(shuffleRange('2026-10-20', '', 'UTC')).toEqual({ from: '2026-10-20T00:00:00.000Z' });
    expect(shuffleRange('', '2026-10-20', 'UTC')).toEqual({ to: '2026-10-20T23:59:59.999Z' });
    expect(shuffleRange('2026-10-22', '2026-10-20', 'UTC')).toBeNull();
    expect(shuffleRange('20/10/2026', '', 'UTC')).toBeNull();
  });
});

describe('canMoveToFront', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const at = '2026-10-21T02:00:00.000Z';
  it('offers it for a channel scheduled in a slot still ahead', () => {
    expect(canMoveToFront({ status: 'scheduled', queueSlotAt: at, effectiveAt: at }, now)).toBe(true);
  });
  it('not for one set for its own time, waiting out a rate limit, due, or not scheduled', () => {
    expect(canMoveToFront({ status: 'scheduled', queueSlotAt: null, effectiveAt: at }, now)).toBe(false);
    expect(canMoveToFront({ status: 'scheduled', queueSlotAt: at, effectiveAt: '2026-10-21T03:00:00.000Z' }, now)).toBe(false);
    expect(canMoveToFront({ status: 'scheduled', queueSlotAt: at, effectiveAt: at }, Date.parse(at))).toBe(false);
    expect(canMoveToFront({ status: 'in_review', queueSlotAt: at, effectiveAt: at }, now)).toBe(false);
  });
});
