import { describe, expect, it } from 'vitest';
import { assignmentReminderDue } from '../src/assign-reminders.ts';
import { MAILED_KINDS, PUSHED_KINDS, dueLabel, notificationPath } from '../src/notifications.ts';
import { pushLine } from '../src/push.ts';

const H = 3_600_000;
const now = new Date('2026-10-26T08:00:00Z');
const at = (hours: number) => new Date(now.getTime() + hours * H);
const state = (over: Partial<Parameters<typeof assignmentReminderDue>[0]> = {}) => ({ dueAt: at(10), soonRemindedAt: null, overdueRemindedAt: null, ...over });

describe('due date reminders of an assigned post (#1359)', () => {
  it('reminds once when the due date is less than a day away', () => {
    expect(assignmentReminderDue(state({ dueAt: at(24.1) }), now)).toBeNull();
    expect(assignmentReminderDue(state({ dueAt: at(24) }), now)).toBe('soon');
    expect(assignmentReminderDue(state({ dueAt: at(1) }), now)).toBe('soon');
    expect(assignmentReminderDue(state({ dueAt: at(1), soonRemindedAt: at(-2) }), now)).toBeNull();
    expect(assignmentReminderDue(state({ dueAt: null }), now)).toBeNull();
  });

  it('reminds once when it is overdue, and only of that once the date has passed', () => {
    expect(assignmentReminderDue(state({ dueAt: now }), now)).toBe('overdue');
    expect(assignmentReminderDue(state({ dueAt: at(-30) }), now)).toBe('overdue');
    // The soon reminder never sent (the date was set already close or past): only the overdue one.
    expect(assignmentReminderDue(state({ dueAt: at(-1), soonRemindedAt: null }), now)).toBe('overdue');
    expect(assignmentReminderDue(state({ dueAt: at(-1), soonRemindedAt: at(-20), overdueRemindedAt: at(-0.5) }), now)).toBeNull();
  });

  it('mails and pushes an assignment and its due date', () => {
    expect(MAILED_KINDS.has('assigned')).toBe(true);
    expect(MAILED_KINDS.has('assignment_due')).toBe(true);
    expect(PUSHED_KINDS.has('assigned')).toBe(true);
    expect(PUSHED_KINDS.has('assignment_due')).toBe(true);
    // Still in the app only.
    expect(MAILED_KINDS.has('comment')).toBe(false);
  });

  it('pushes a line naming the kind, never the post text', () => {
    expect(pushLine('assignment_due', { stage: 'soon', due: '2026-10-26T18:00:00.000Z' })).toBe('Một bài được giao cho bạn sắp đến hạn');
    expect(pushLine('assignment_due', { stage: 'overdue' })).toBe('Một bài được giao cho bạn đã quá hạn');
    expect(pushLine('assigned', {})).toBe('Bạn được giao một bài mới');
    expect(pushLine('assigned', { count: '3' })).toBe('Bạn được giao 3 bài mới');
    // A count it did not write is not shown.
    expect(pushLine('assigned', { count: '<b>3</b>' })).toBe('Bạn được giao một bài mới');
  });

  it('opens the post, or the posts assigned to the reader for a bulk assignment', () => {
    const post = '0190a3c4-0000-7000-8000-000000000001';
    expect(notificationPath('acme', 'assignment_due', post, null)).toBe(`/o/acme/social/${post}`);
    expect(notificationPath('acme', 'assigned', post, null)).toBe(`/o/acme/social/${post}`);
    expect(notificationPath('acme', 'assigned', null, null)).toBe('/o/acme/social?assignee=me');
    expect(notificationPath('acme', 'comment', null, null)).toBe('/o/acme/social/channels');
  });

  it("writes the due date for the mail in the post's time zone", () => {
    expect(dueLabel(new Date('2026-10-26T07:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('14:30 26/10/2026');
    expect(dueLabel(new Date('2026-10-26T23:05:00Z'), 'Asia/Ho_Chi_Minh')).toBe('06:05 27/10/2026');
    expect(dueLabel(new Date('2026-10-26T07:30:00Z'), 'Europe/London')).toBe('07:30 26/10/2026');
    // A zone the runtime does not know falls back to Vietnam's.
    expect(dueLabel(new Date('2026-10-26T07:30:00Z'), 'Not/AZone')).toBe('14:30 26/10/2026');
    expect(dueLabel(new Date('2026-10-26T17:00:00Z'), null)).toBe('00:00 27/10/2026');
  });
});
