// Copies of many posts at once, moved by days or weeks (#1192): the copy's time keeps the weekday and the local clock
// time in the post's zone across a daylight-saving change, zero gives undated drafts, and each post is sent on its own,
// a refusal never stopping the others.
import { describe, expect, it } from 'vitest';
import { localTime } from '@crove/mod-social/contract';
import { duplicateSummary, duplicateTime, runDuplicate, sourceTime, validDuplicate, type BulkPost, type BulkVariant, type DuplicateRepeat } from '../src/lib/social-bulk.ts';

const v = (id: string, status: string, effectiveAt: string | null): BulkVariant => ({ id, connectionId: `c-${id}`, status, revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, effectiveAt, queueSlotAt: null });
const post = (id: string, timeZone: string, variants: BulkVariant[], scheduledAt: string | null = null): BulkPost => ({ id, timeZone, scheduledAt, variants });
const ms = (iso: string) => Date.parse(iso);
// A "now" well before every time below.
const EARLY = ms('2026-01-01T00:00:00.000Z');
const at = (r: ReturnType<typeof duplicateTime>) => ('at' in r ? r.at : r.skip);

describe('the time of a copy moved by days or weeks (#1192)', () => {
  it('keeps the weekday and the local time across a daylight-saving change', () => {
    // New York moves to daylight time on 2026-03-08: Thursday 09:00 EST is 14:00Z, the next Thursday 09:00 EDT is 13:00Z.
    expect(at(duplicateTime(post('p', 'America/New_York', [v('a', 'published', '2026-03-05T14:00:00.000Z')]), { amount: 1, unit: 'weeks' }, EARLY))).toBe('2026-03-12T13:00:00.000Z');
    // Berlin leaves summer time on 2026-10-25: Monday 09:00 CEST is 07:00Z, the next Monday 09:00 CET is 08:00Z.
    const berlin = duplicateTime(post('p', 'Europe/Berlin', [v('a', 'scheduled', '2026-10-19T07:00:00.000Z')]), { amount: 1, unit: 'weeks' }, EARLY);
    expect(at(berlin)).toBe('2026-10-26T08:00:00.000Z');
    const local = localTime(ms(at(berlin) as string), 'Europe/Berlin');
    expect([local.year, local.month, local.day, local.hour, local.minute]).toEqual([2026, 10, 26, 9, 0]);
    // Days keep the clock time too: Saturday 09:00 in New York before the change is Monday 09:00 after it.
    expect(at(duplicateTime(post('p', 'America/New_York', [v('a', 'draft', '2026-03-07T14:00:00.000Z')]), { amount: 2, unit: 'days' }, EARLY))).toBe('2026-03-09T13:00:00.000Z');
  });

  it('moves ten posts of one week to the same weekdays and times of the next', () => {
    const zone = 'Asia/Ho_Chi_Minh';
    // Monday 2026-11-02 to Sunday 2026-11-08, then two more on Monday and Wednesday, at various local times.
    const times = ['2026-11-02T01:00:00.000Z', '2026-11-03T02:30:00.000Z', '2026-11-04T04:00:00.000Z', '2026-11-05T10:15:00.000Z', '2026-11-06T12:00:00.000Z', '2026-11-07T00:45:00.000Z', '2026-11-08T13:00:00.000Z', '2026-11-02T11:00:00.000Z', '2026-11-04T08:00:00.000Z', '2026-11-08T03:00:00.000Z'];
    for (const t of times) {
      const copy = duplicateTime(post('p', zone, [v('a', 'published', t)]), { amount: 1, unit: 'weeks' }, EARLY);
      const from = localTime(ms(t), zone);
      const to = localTime(ms(at(copy) as string), zone);
      expect(new Date(Date.UTC(to.year, to.month - 1, to.day)).getUTCDay()).toBe(new Date(Date.UTC(from.year, from.month - 1, from.day)).getUTCDay());
      expect([to.hour, to.minute]).toEqual([from.hour, from.minute]);
      expect(ms(at(copy) as string) - ms(t)).toBe(7 * 86_400_000);
    }
  });

  it('gives undated drafts for zero, and skips a post with no time or a copy that would be in the past', () => {
    const undated = post('p', 'Asia/Ho_Chi_Minh', [v('a', 'draft', null)]);
    expect(duplicateTime(undated, { amount: 0, unit: 'weeks' }, EARLY)).toEqual({ at: null });
    expect(duplicateTime(undated, { amount: 1, unit: 'days' }, EARLY)).toEqual({ skip: 'undated' });
    const old = post('p', 'Asia/Ho_Chi_Minh', [v('a', 'published', '2026-03-01T02:00:00.000Z')]);
    expect(duplicateTime(old, { amount: 1, unit: 'weeks' }, ms('2026-03-08T02:00:00.000Z'))).toEqual({ skip: 'past' });
    expect(duplicateTime(old, { amount: 2, unit: 'weeks' }, ms('2026-03-08T02:00:00.000Z'))).toEqual({ at: '2026-03-15T02:00:00.000Z' });
  });

  it('moves from the earliest channel still on its way or sent, else the post\'s planned time', () => {
    const p = post('p', 'Asia/Ho_Chi_Minh', [v('a', 'scheduled', '2026-11-03T02:00:00.000Z'), v('b', 'published', '2026-11-02T02:00:00.000Z'), v('c', 'cancelled', '2026-11-01T02:00:00.000Z')]);
    expect(sourceTime(p)).toBe(ms('2026-11-02T02:00:00.000Z'));
    expect(sourceTime(post('p', 'Asia/Ho_Chi_Minh', [v('a', 'draft', null)], '2026-11-05T02:00:00.000Z'))).toBe(ms('2026-11-05T02:00:00.000Z'));
    expect(sourceTime(post('p', 'Asia/Ho_Chi_Minh', [v('a', 'draft', null)]))).toBeNull();
  });

  it('accepts whole shifts from zero within the limit', () => {
    expect(validDuplicate({ amount: 0, unit: 'days' })).toBe(true);
    expect(validDuplicate({ amount: 4, unit: 'weeks' })).toBe(true);
    expect(validDuplicate({ amount: -1, unit: 'days' })).toBe(false);
    expect(validDuplicate({ amount: 1.5, unit: 'weeks' })).toBe(false);
    expect(validDuplicate({ amount: Number.NaN, unit: 'days' })).toBe(false);
    expect(validDuplicate({ amount: 1000, unit: 'days' })).toBe(false);
  });
});

describe('copying the selected posts one after another (#1192)', () => {
  it('sends each post with its time, tells skips from refusals, and carries the repeats on X or LinkedIn', async () => {
    const zone = 'Asia/Ho_Chi_Minh';
    const posts = [
      post('ok', zone, [v('a', 'published', '2026-11-02T02:00:00.000Z')]),
      post('undated', zone, [v('b', 'draft', null)]),
      post('gone', zone, [v('c', 'published', '2026-11-03T02:00:00.000Z')]),
      post('theirs', zone, [v('d', 'published', '2026-11-03T02:00:00.000Z')]),
      post('broken', zone, [v('e', 'published', '2026-11-04T02:00:00.000Z')]),
      post('repeat', zone, [v('f', 'published', '2026-11-05T02:00:00.000Z')]),
    ];
    const repeat: DuplicateRepeat = { variantId: 'copy-f', connectionId: 'c-f', provider: 'x', at: '2026-11-05T02:00:00.000Z', status: 'published' };
    const sent: Array<{ postId: string; scheduledAt: string | null }> = [];
    const progress: number[] = [];
    const results = await runDuplicate(
      posts,
      { amount: 1, unit: 'weeks' },
      async (r) => {
        sent.push(r);
        if (r.postId === 'gone') throw Object.assign(new Error('x'), { code: 'NOTHING_TO_DUPLICATE' });
        if (r.postId === 'theirs') throw Object.assign(new Error('x'), { code: 'CHANNEL_NOT_ALLOWED' });
        if (r.postId === 'broken') throw Object.assign(new Error('x'), { code: 'INTERNAL_SERVER_ERROR' });
        return { postId: `copy-of-${r.postId}`, repeats: r.postId === 'repeat' ? [repeat] : [] };
      },
      EARLY,
      (done) => progress.push(done),
    );
    // The undated post is never sent; every other one is, with its time a week on.
    expect(sent).toEqual([
      { postId: 'ok', scheduledAt: '2026-11-09T02:00:00.000Z' },
      { postId: 'gone', scheduledAt: '2026-11-10T02:00:00.000Z' },
      { postId: 'theirs', scheduledAt: '2026-11-10T02:00:00.000Z' },
      { postId: 'broken', scheduledAt: '2026-11-11T02:00:00.000Z' },
      { postId: 'repeat', scheduledAt: '2026-11-12T02:00:00.000Z' },
    ]);
    expect(results.map((r) => [r.postId, r.outcome, r.outcome === 'skipped' ? r.reason : r.outcome === 'done' ? r.copyId : null])).toEqual([
      ['ok', 'done', 'copy-of-ok'],
      ['undated', 'skipped', 'undated'],
      ['gone', 'skipped', 'noChannel'],
      ['theirs', 'skipped', 'notAllowed'],
      ['broken', 'refused', null],
      ['repeat', 'done', 'copy-of-repeat'],
    ]);
    expect(results.at(-1)).toMatchObject({ outcome: 'done', repeats: [repeat] });
    expect(duplicateSummary(results)).toEqual({ done: 2, skipped: 3, refused: 1, repeats: 1 });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('sends undated copies for zero, even of a post with no time', async () => {
    const sent: Array<string | null> = [];
    await runDuplicate([post('a', 'Asia/Ho_Chi_Minh', [v('a', 'draft', null)]), post('b', 'Asia/Ho_Chi_Minh', [v('b', 'published', '2026-11-02T02:00:00.000Z')])], { amount: 0, unit: 'days' }, async (r) => {
      sent.push(r.scheduledAt);
      return { postId: 'copy', repeats: [] };
    }, EARLY);
    expect(sent).toEqual([null, null]);
  });
});
