import { describe, expect, it } from 'vitest';
import { dayRange, parseSocialSearch, sameViewFilters, searchOfView, viewFiltersOf } from '../src/lib/social.ts';

describe('Social home address (#574)', () => {
  it('keeps only valid tabs, channel ids, a trimmed search and calendar days', () => {
    const channel = '0190a000-0000-7000-8000-000000000001';
    expect(parseSocialSearch({ tab: 'drafts', channel, q: '  khai trương ', from: '2026-10-01', to: '2026-10-31' })).toEqual({ tab: 'drafts', channel, q: 'khai trương', from: '2026-10-01', to: '2026-10-31' });
    expect(parseSocialSearch({ tab: 'nope', channel: 'x', q: '   ', from: '01/10/2026', to: 5 })).toEqual({});
    expect(parseSocialSearch({ q: 'a'.repeat(300) }).q).toHaveLength(200);
    // A label filter (#639) is a label id or nothing.
    expect(parseSocialSearch({ tab: 'metrics', label: channel })).toEqual({ tab: 'metrics', label: channel });
    expect(parseSocialSearch({ label: 'Tết' })).toEqual({});
  });

  it('keeps whose posts and the calendar period in the address, and reads the old mine=1 links (#1300)', () => {
    const member = '0190A000-0000-7000-8000-00000000000B';
    expect(parseSocialSearch({ tab: 'calendar', assignee: 'me', author: member, view: 'week', date: '2026-10-26' })).toEqual({
      tab: 'calendar',
      assignee: 'me',
      author: member.toLowerCase(),
      view: 'week',
      date: '2026-10-26',
    });
    expect(parseSocialSearch({ mine: '1' })).toEqual({ assignee: 'me' });
    // A member filter beats the old flag; nonsense is dropped, a day that does not exist too.
    expect(parseSocialSearch({ mine: '1', assignee: member })).toEqual({ assignee: member.toLowerCase() });
    expect(parseSocialSearch({ assignee: 'lan', author: 5, view: 'day', date: '2026-02-31', from: '2026-13-01' })).toEqual({});
  });

  it('saves a view of every filter but the calendar day, and opens one through the same checks (#1300)', () => {
    const channel = '0190a000-0000-7000-8000-000000000001';
    expect(viewFiltersOf({ tab: 'calendar', channel, view: 'week', date: '2026-10-26', assignee: 'me' })).toEqual({ tab: 'calendar', channel, view: 'week', assignee: 'me' });
    // The metrics and the library are no view of the posts.
    expect(viewFiltersOf({ tab: 'metrics', label: channel })).toEqual({ label: channel });
    expect(sameViewFilters({ tab: 'board', author: 'me' }, { author: 'me', tab: 'board' })).toBe(true);
    expect(sameViewFilters({ tab: 'board' }, { tab: 'board', author: 'me' })).toBe(false);
    expect(searchOfView({ tab: 'board', author: 'me', date: '2026-10-26', extra: 'x' })).toEqual({ tab: 'board', author: 'me' });
  });

  it('turns local days into a range that includes the last day', () => {
    const r = dayRange('2026-10-01', '2026-10-01');
    expect(Date.parse(r.to as string) - Date.parse(r.from as string)).toBe(24 * 3_600_000);
    expect(new Date(r.from as string).getHours()).toBe(0);
    expect(dayRange(undefined, undefined)).toEqual({});
  });
});