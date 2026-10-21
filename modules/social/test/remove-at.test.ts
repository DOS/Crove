import { describe, expect, it } from 'vitest';
import { REMOVE_AT_MIN_GAP_MS, REMOVE_READY, removeAtOf, removeAtTooSoon, type Provider } from '../src/domain/channels.ts';
import { validateVariant } from '../src/domain/validate.ts';
import { removeDue } from '../src/remove.ts';

describe('a post taken down at a set time (#861)', () => {
  const base = { body: 'Khuyến mãi cuối tuần', title: null, media: [] };
  const issues = (provider: Provider, settings: Record<string, unknown>) =>
    validateVariant({ ...base, provider, settings }).filter((i) => i.code.startsWith('REMOVE_AT')).map((i) => [i.code, i.field]);

  it('reads a full ISO 8601 time with Z or an offset as an instant in UTC', () => {
    expect(removeAtOf({ removeAt: '2026-10-21T22:00:00+07:00' })).toBe('2026-10-21T15:00:00.000Z');
    expect(removeAtOf({ removeAt: '2026-10-21T15:00Z' })).toBe('2026-10-21T15:00:00.000Z');
    expect(removeAtOf({ removeAt: '2026-10-21T15:00:30.250Z' })).toBe('2026-10-21T15:00:30.250Z');
    expect(removeAtOf({ removeAt: '2026-10-21T15:00:00-05:30' })).toBe('2026-10-21T20:30:00.000Z');
    expect(removeAtOf({})).toBeNull();
    expect(removeAtOf({ removeAt: null })).toBeNull();
    expect(removeAtOf(undefined)).toBeNull();
  });

  it('refuses a time without its zone, a date alone, a day the calendar lacks and anything that is not text', () => {
    for (const bad of ['2026-10-21T22:00:00', '2026-10-21', '2026-02-29T10:00:00Z', '2026-04-31T10:00Z', '2026-13-01T10:00Z', '2026-10-21T24:00Z', '2026-10-21T22:00+15:00', 'tomorrow', '', 1_760_000_000_000, { at: 'x' }]) {
      expect(removeAtOf({ removeAt: bad }), String(bad)).toBe('invalid');
    }
    // A leap day is a day.
    expect(removeAtOf({ removeAt: '2028-02-29T10:00:00Z' })).toBe('2028-02-29T10:00:00.000Z');
  });

  it('takes a time on the channels Crove can take a post down from, and names the field otherwise', () => {
    for (const provider of REMOVE_READY) expect(issues(provider, { removeAt: '2026-10-21T22:00:00+07:00' })).toEqual([]);
    expect(issues('bluesky', { removeAt: '22:00' })).toEqual([['REMOVE_AT_INVALID', 'settings.removeAt']]);
    // A channel outside REMOVE_READY is refused whatever the value, as reposts are.
    for (const provider of ['facebook_page', 'instagram', 'linkedin', 'threads', 'youtube'] as const) {
      expect(issues(provider, { removeAt: '2026-10-21T22:00:00Z' })).toEqual([['REMOVE_AT_NOT_SUPPORTED', 'settings.removeAt']]);
      expect(issues(provider, { removeAt: 'soon' })).toEqual([['REMOVE_AT_NOT_SUPPORTED', 'settings.removeAt']]);
    }
    // A Story is not taken down, even on a channel that removes posts.
    expect(issues('sandbox', { removeAt: '2026-10-21T22:00:00Z', postType: 'story' })).toEqual([['REMOVE_AT_NOT_SUPPORTED', 'settings.removeAt']]);
    expect(issues('bluesky', {})).toEqual([]);
  });

  it('wants the takedown at least five minutes after the post goes out', () => {
    const at = new Date('2026-10-21T15:00:00Z');
    expect(REMOVE_AT_MIN_GAP_MS).toBe(5 * 60_000);
    expect(removeAtTooSoon({ removeAt: '2026-10-21T22:05:00+07:00' }, at)).toBe(false);
    expect(removeAtTooSoon({ removeAt: '2026-10-21T22:04:59+07:00' }, at)).toBe(true);
    expect(removeAtTooSoon({ removeAt: '2026-10-21T14:00:00Z' }, at)).toBe(true);
    // Nothing set, or a value the validation names already: nothing to refuse here.
    expect(removeAtTooSoon({}, at)).toBe(false);
    expect(removeAtTooSoon({ removeAt: 'soon' }, at)).toBe(false);
  });

  it('is due once its time has come, only for a post that went out before that time', () => {
    const settings = { removeAt: '2026-10-21T22:00:00+07:00' };
    const published = new Date('2026-10-21T08:00:00Z');
    expect(removeDue(settings, published, new Date('2026-10-21T14:59:59Z'))).toBe(false);
    expect(removeDue(settings, published, new Date('2026-10-21T15:00:00Z'))).toBe(true);
    // Published late, after the planned takedown: it stays up.
    expect(removeDue(settings, new Date('2026-10-21T15:30:00Z'), new Date('2026-10-21T16:00:00Z'))).toBe(false);
    expect(removeDue(settings, null, new Date('2026-10-21T16:00:00Z'))).toBe(false);
    expect(removeDue({ removeAt: 'soon' }, published, new Date('2026-10-22T00:00:00Z'))).toBe(false);
    expect(removeDue({}, published, new Date('2026-10-22T00:00:00Z'))).toBe(false);
  });
});
