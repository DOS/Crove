import { describe, expect, it } from 'vitest';
import { remindersDue } from '../src/reminders.ts';

const H = 3_600_000;
const now = new Date('2026-10-21T08:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * H);
const ahead = (hours: number) => new Date(now.getTime() + hours * H);
const variant = (over: Partial<Parameters<typeof remindersDue>[0]> = {}) => ({ reviewSince: ago(1), remindedWaitingAt: null, remindedDueAt: null, at: null, ...over });

describe('review reminders due (#703)', () => {
  it('reminds once of a review that has waited a day', () => {
    expect(remindersDue(variant({ reviewSince: ago(23.9) }), now)).toEqual({ waiting: false, due: false });
    expect(remindersDue(variant({ reviewSince: ago(24) }), now)).toEqual({ waiting: true, due: false });
    expect(remindersDue(variant({ reviewSince: ago(30), remindedWaitingAt: ago(2) }), now)).toEqual({ waiting: false, due: false });
    expect(remindersDue(variant({ reviewSince: null }), now)).toEqual({ waiting: false, due: false });
  });

  it('reminds once when the time is less than a day away, if it was further when the review was asked', () => {
    expect(remindersDue(variant({ reviewSince: ago(2), at: ahead(30) }), now)).toEqual({ waiting: false, due: false });
    expect(remindersDue(variant({ reviewSince: ago(2), at: ahead(23) }), now)).toEqual({ waiting: false, due: true });
    // Asked inside the last day before the time: the request itself was the reminder.
    expect(remindersDue(variant({ reviewSince: ago(2), at: ahead(21) }), now)).toEqual({ waiting: false, due: false });
    expect(remindersDue(variant({ reviewSince: ago(30), at: ahead(5) }), now)).toEqual({ waiting: true, due: true });
    expect(remindersDue(variant({ reviewSince: ago(30), at: ahead(5), remindedDueAt: ago(1), remindedWaitingAt: ago(1) }), now)).toEqual({ waiting: false, due: false });
    // A time already passed is not reminded of.
    expect(remindersDue(variant({ reviewSince: ago(2), at: ago(1) }), now)).toEqual({ waiting: false, due: false });
  });
});
