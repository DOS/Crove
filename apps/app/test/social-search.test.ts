import { describe, expect, it } from 'vitest';
import { dayRange, parseSocialSearch } from '../src/lib/social.ts';

describe('Social home address (#574)', () => {
  it('keeps only valid tabs, channel ids, a trimmed search and calendar days', () => {
    const channel = '0190a000-0000-7000-8000-000000000001';
    expect(parseSocialSearch({ tab: 'drafts', channel, q: '  khai trương ', from: '2026-10-01', to: '2026-10-31' })).toEqual({ tab: 'drafts', channel, q: 'khai trương', from: '2026-10-01', to: '2026-10-31' });
    expect(parseSocialSearch({ tab: 'nope', channel: 'x', q: '   ', from: '01/10/2026', to: 5 })).toEqual({});
    expect(parseSocialSearch({ q: 'a'.repeat(300) }).q).toHaveLength(200);
  });

  it('turns local days into a range that includes the last day', () => {
    const r = dayRange('2026-10-01', '2026-10-01');
    expect(Date.parse(r.to as string) - Date.parse(r.from as string)).toBe(24 * 3_600_000);
    expect(new Date(r.from as string).getHours()).toBe(0);
    expect(dayRange(undefined, undefined)).toEqual({});
  });
});