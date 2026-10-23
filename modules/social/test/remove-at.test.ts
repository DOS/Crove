import { describe, expect, it } from 'vitest';
import { REMOVE_AT_MAX_MS, REMOVE_AT_MIN_GAP_MS, REMOVE_READY, REMOVE_WINDOW_MS, removeAtFit, removeAtOf, removeWindowMs, type Provider } from '../src/domain/channels.ts';
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
    for (const provider of ['facebook_page', 'instagram', 'tiktok', 'threads', 'youtube'] as const) {
      expect(issues(provider, { removeAt: '2026-10-21T22:00:00Z' })).toEqual([['REMOVE_AT_NOT_SUPPORTED', 'settings.removeAt']]);
      expect(issues(provider, { removeAt: 'soon' })).toEqual([['REMOVE_AT_NOT_SUPPORTED', 'settings.removeAt']]);
    }
    // A Story is not taken down, even on a channel that removes posts.
    expect(issues('sandbox', { removeAt: '2026-10-21T22:00:00Z', postType: 'story' })).toEqual([['REMOVE_AT_NOT_SUPPORTED', 'settings.removeAt']]);
    expect(issues('bluesky', {})).toEqual([]);
  });

  it('wants the takedown at least five minutes and at most the channel window after the post goes out', () => {
    const at = new Date('2026-10-21T15:00:00Z');
    expect(REMOVE_AT_MIN_GAP_MS).toBe(5 * 60_000);
    expect(removeAtFit('bluesky', { removeAt: '2026-10-21T22:05:00+07:00' }, at)).toBeNull();
    expect(removeAtFit('bluesky', { removeAt: '2026-10-21T22:04:59+07:00' }, at)).toEqual({ problem: 'too_soon' });
    expect(removeAtFit('bluesky', { removeAt: '2026-10-21T14:00:00Z' }, at)).toEqual({ problem: 'too_soon' });
    // A year at most anywhere; Telegram lets a bot delete a channel post within 48 hours only.
    expect(REMOVE_AT_MAX_MS).toBe(365 * 24 * 3_600_000);
    expect(removeAtFit('bluesky', { removeAt: new Date(at.getTime() + REMOVE_AT_MAX_MS).toISOString() }, at)).toBeNull();
    expect(removeAtFit('bluesky', { removeAt: new Date(at.getTime() + REMOVE_AT_MAX_MS + 1000).toISOString() }, at)).toEqual({ problem: 'too_late', hours: 8760 });
    expect(REMOVE_WINDOW_MS).toEqual({ telegram: 48 * 3_600_000 });
    expect(removeWindowMs('telegram')).toBe(48 * 3_600_000);
    expect(removeWindowMs('mastodon')).toBe(REMOVE_AT_MAX_MS);
    expect(removeAtFit('telegram', { removeAt: '2026-10-23T15:00:00Z' }, at)).toBeNull();
    expect(removeAtFit('telegram', { removeAt: '2026-10-23T15:00:01Z' }, at)).toEqual({ problem: 'too_late', hours: 48 });
    // Nothing set, or a value the validation names already: nothing to refuse here.
    expect(removeAtFit('bluesky', {}, at)).toBeNull();
    expect(removeAtFit('bluesky', { removeAt: 'soon' }, at)).toBeNull();
  });

  it('is due once its time has come, only while it still fits the time the post really went out', () => {
    const settings = { removeAt: '2026-10-21T22:00:00+07:00' };
    const published = new Date('2026-10-21T08:00:00Z');
    expect(removeDue('bluesky', settings, published, new Date('2026-10-21T14:59:59Z'))).toBe(false);
    expect(removeDue('bluesky', settings, published, new Date('2026-10-21T15:00:00Z'))).toBe(true);
    // Published late (a rate limit, a paused channel): after the takedown, or less than five minutes before it.
    expect(removeDue('bluesky', settings, new Date('2026-10-21T15:30:00Z'), new Date('2026-10-21T16:00:00Z'))).toBe(false);
    expect(removeDue('bluesky', settings, new Date('2026-10-21T14:55:10Z'), new Date('2026-10-21T16:00:00Z'))).toBe(false);
    expect(removeDue('bluesky', settings, new Date('2026-10-21T14:55:00Z'), new Date('2026-10-21T16:00:00Z'))).toBe(true);
    // Telegram: past its 48 hours, the bot can no longer delete it.
    expect(removeDue('telegram', settings, new Date('2026-10-19T14:59:59Z'), new Date('2026-10-21T16:00:00Z'))).toBe(false);
    expect(removeDue('telegram', settings, new Date('2026-10-19T15:00:00Z'), new Date('2026-10-21T16:00:00Z'))).toBe(true);
    expect(removeDue('bluesky', settings, null, new Date('2026-10-21T16:00:00Z'))).toBe(false);
    expect(removeDue('bluesky', { removeAt: 'soon' }, published, new Date('2026-10-22T00:00:00Z'))).toBe(false);
    expect(removeDue('bluesky', {}, published, new Date('2026-10-22T00:00:00Z'))).toBe(false);
  });
});